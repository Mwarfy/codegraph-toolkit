// ADR-005
/**
 * `codegraph analyze` — run all detectors et génère un snapshot.
 *
 * Extrait du god-file `cli/index.ts` (P2a split). La registration
 * `.command('analyze')` reste dans `index.ts`, le handler est ici.
 *
 * Outputs :
 *   - `snapshot-<ts>-<commit>.json` (canonical)
 *   - `synopsis.json` + `synopsis-level{1,2,3}.md` (ADR-009)
 *   - `facts/<Relation>.facts` + `schema.dl` (ADR-022)
 *   - `MAP.md` à la racine si `--map`
 */

import chalk from 'chalk'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { analyze } from '../../core/analyzer.js'
import { buildSynopsis, renderLevel1, renderLevel2, renderLevel3 } from '../../synopsis/builder.js'
import { collectAdrMarkers } from '../../synopsis/adr-markers.js'
import { buildMap } from '../../map/builder.js'
import { exportFacts } from '../../facts/index.js'
import { loadConfig, defaultSnapshotPath, pruneSnapshots, formatHealth } from '../_shared.js'

export interface AnalyzeOpts {
  config?: string
  root?: string
  output?: string
  detectors?: string
  save?: boolean
  map?: boolean
  incremental?: boolean
}

export async function runAnalyzeCommand(opts: AnalyzeOpts): Promise<void> {
  const config = await loadConfig(opts)

  const incremental = Boolean(opts.incremental)
  console.log(chalk.bold('\n🔍 CodeGraph — Analyzing...\n'))
  console.log(`  Root:       ${config.rootDir}`)
  console.log(`  Include:    ${config.include.join(', ')}`)
  console.log(`  Detectors:  ${config.detectors.join(', ')}`)
  if (incremental) console.log(`  Mode:       ${chalk.cyan('incremental (Salsa)')}`)
  console.log()

  const result = await analyze(config, { incremental })
  const { snapshot, timing } = result

  printAnalyzeStats(snapshot)
  printExportsSummary(snapshot)
  printTiming(timing)

  if (opts.save !== false) {
    await persistAnalyzeOutputs(opts, snapshot, config)
  } else {
    process.stdout.write(JSON.stringify(snapshot, null, 2))
  }
}

function printAnalyzeStats(snapshot: import('../../core/types.js').GraphSnapshot): void {
  console.log(chalk.bold('  Results:\n'))
  console.log(`  Files:      ${snapshot.stats.totalFiles}`)
  console.log(`  Edges:      ${snapshot.stats.totalEdges}`)
  console.log(`  Orphans:    ${chalk.yellow(String(snapshot.stats.orphanCount))}`)
  console.log(`  Connected:  ${chalk.green(String(snapshot.stats.connectedCount))}`)
  console.log(`  Entry pts:  ${snapshot.stats.entryPointCount}`)
  console.log(`  Uncertain:  ${snapshot.stats.uncertainCount}`)
  console.log(`  Health:     ${formatHealth(snapshot.stats.healthScore)}`)
  console.log()

  console.log(chalk.bold('  Edges by type:'))
  for (const [type, count] of Object.entries(snapshot.stats.edgesByType)) {
    if (count > 0) {
      console.log(`    ${type.padEnd(15)} ${count}`)
    }
  }
  console.log()
}

interface ExportConfidenceCounts {
  safe: number
  test: number
  dynamic: number
  local: number
}

function printExportsSummary(snapshot: import('../../core/types.js').GraphSnapshot): void {
  const filesWithExports = snapshot.nodes.filter((n) => n.exports && n.exports.length > 0)
  if (filesWithExports.length === 0) return

  const totalExports = filesWithExports.reduce((s, n) => s + n.exports!.length, 0)
  const conf = countExportsByConfidence(filesWithExports)
  const totalUnused = conf.safe + conf.test + conf.dynamic + conf.local

  console.log(chalk.bold('  Exports:'))
  console.log(`    Analyzed:     ${totalExports} symbols across ${filesWithExports.length} files`)
  if (totalUnused === 0) {
    console.log(`    Unused:       ${chalk.green('0')} — all exports are consumed!`)
    console.log()
    return
  }
  printUnusedBreakdown(conf)
  printTopDeadExportFiles(filesWithExports)
  console.log()
}

/** Mapping confidence string → ExportConfidenceCounts bucket key. */
const CONFIDENCE_TO_BUCKET: Record<string, keyof ExportConfidenceCounts | undefined> = {
  'safe-to-remove': 'safe',
  'test-only': 'test',
  'possibly-dynamic': 'dynamic',
  'local-only': 'local',
}

function countExportsByConfidence(
  filesWithExports: import('../../core/types.js').GraphSnapshot['nodes'],
): ExportConfidenceCounts {
  const conf: ExportConfidenceCounts = { safe: 0, test: 0, dynamic: 0, local: 0 }
  for (const n of filesWithExports) {
    for (const e of n.exports!) {
      const bucket = CONFIDENCE_TO_BUCKET[(e as any).confidence]
      if (bucket) conf[bucket]++
    }
  }
  return conf
}

function printUnusedBreakdown(conf: ExportConfidenceCounts): void {
  console.log(
    `    ${chalk.red(String(conf.safe))} safe to remove · ` +
    `${chalk.magenta(String(conf.local))} local-only · ` +
    `${chalk.blue(String(conf.test))} test-only · ` +
    `${chalk.yellow(String(conf.dynamic))} possibly dynamic`,
  )
}

function printTopDeadExportFiles(
  filesWithExports: import('../../core/types.js').GraphSnapshot['nodes'],
): void {
  const ranked = filesWithExports
    .map((n) => ({
      file: n.id,
      safe: n.exports!.filter((e: any) => e.confidence === 'safe-to-remove').length,
      total: n.exports!.length,
    }))
    .filter((r) => r.safe > 0)
    .sort((a, b) => b.safe - a.safe)
    .slice(0, 5)
  if (ranked.length === 0) return
  console.log(chalk.dim('    Top dead-export files:'))
  for (const r of ranked) {
    console.log(chalk.dim(`      ${r.safe}/${r.total} safe  ${r.file}`))
  }
}

function printTiming(timing: import('../../core/analyzer.js').AnalyzeResult['timing']): void {
  console.log(chalk.dim(`  Timing:`))
  console.log(chalk.dim(`    File discovery: ${timing.fileDiscovery.toFixed(0)}ms`))
  for (const [name, ms] of Object.entries(timing.detectors)) {
    console.log(chalk.dim(`    ${name}: ${(ms as number).toFixed(0)}ms`))
  }
  console.log(chalk.dim(`    Graph build:    ${timing.graphBuild.toFixed(0)}ms`))
  console.log(chalk.dim(`    Total:          ${timing.total.toFixed(0)}ms`))
  console.log()
}

async function persistAnalyzeOutputs(
  opts: AnalyzeOpts,
  snapshot: import('../../core/types.js').GraphSnapshot,
  config: import('../../core/types.js').CodeGraphConfig,
): Promise<void> {
  const outPath = opts.output || await defaultSnapshotPath(config)
  await fs.mkdir(path.dirname(outPath), { recursive: true })
  await fs.writeFile(outPath, JSON.stringify(snapshot, null, 2))
  console.log(chalk.green(`  ✓ Snapshot saved: ${outPath}\n`))

  // Prune anciens snapshots. config.maxSnapshots cap (default 50).
  // On garde les N plus récents par nom de fichier (timestamp lex-sortable).
  const pruned = await pruneSnapshots(path.dirname(outPath), config.maxSnapshots)
  if (pruned > 0) {
    console.log(chalk.dim(`  ✓ Pruned ${pruned} old snapshot(s) (kept ${config.maxSnapshots})\n`))
  }

  // Dérivatifs ADR-009 : synopsis.json + synopsis-level{1,2,3}.md.
  // Lien 1+2 ADR-toolkit : collecte les marqueurs `// ADR-NNN` hors-builder
  // pour préserver la pureté (cf. ADR-009 — projection déterministe).
  const adrMarkers = await collectAdrMarkers(config.rootDir)
  const synopsis = buildSynopsis(snapshot, { adrMarkers })
  const snapDir = path.dirname(outPath)
  await fs.writeFile(path.join(snapDir, 'synopsis.json'), JSON.stringify(synopsis, null, 2))
  const l1 = renderLevel1(synopsis)
  await fs.writeFile(path.join(snapDir, 'synopsis-level1.md'), l1)
  await fs.writeFile(path.join(snapDir, 'synopsis.md'), l1)
  await fs.writeFile(path.join(snapDir, 'synopsis-level2.md'), renderLevel2(synopsis))
  // Write level3 files en parallèle (par container, indépendants).
  await Promise.all(
    synopsis.containers.map((c) =>
      fs.writeFile(
        path.join(snapDir, `synopsis-level3-${c.id}.md`),
        renderLevel3(synopsis, c.id),
      ),
    ),
  )
  console.log(chalk.green(
    `  ✓ Synopsis written: synopsis.json + ${synopsis.containers.length + 2} markdown files in ${snapDir}\n`,
  ))

  // Datalog facts derivative — un fichier .facts par relation + schema.dl.
  // Régen à chaque analyze (cf. ADR-022).
  try {
    const factsResult = await exportFacts(snapshot, {
      outDir: path.join(snapDir, 'facts'),
    })
    const totalTuples = factsResult.relations.reduce((s, r) => s + r.tuples, 0)
    console.log(chalk.green(
      `  ✓ Facts written: ${factsResult.relations.length} relations, ${totalTuples} tuples ` +
      `in ${path.relative(process.cwd(), factsResult.outDir)}\n`,
    ))
  } catch (err) {
    console.error(
      chalk.yellow(`  ⚠ Facts export failed: ${err instanceof Error ? err.message : String(err)}`),
    )
  }

  if (opts.map) {
    const mapContent = buildMap(snapshot, { concerns: config.concerns })
    const mapPath = path.join(config.rootDir, 'MAP.md')
    await fs.writeFile(mapPath, mapContent)
    const approxTokens = Math.round(mapContent.length / 4)
    console.log(chalk.green(`  ✓ MAP.md written: ${mapPath} (~${approxTokens} tokens)\n`))
  }
}
