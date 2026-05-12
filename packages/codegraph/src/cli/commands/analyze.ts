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
import { detectWorkspaces } from '../../core/workspaces.js'
import { resolveGrandfatheredArticulations } from '../../core/articulation-baseline.js'
import { loadConfig, defaultSnapshotPath, pruneLegacySnapshots, formatHealth } from '../_shared.js'
import { computeInputHash } from '../../incremental/input-hash.js'
import {
  writeStoredSnapshot,
  type SnapshotMeta,
  SNAPSHOT_VERSION,
} from '../../incremental/snapshot-store.js'
import {
  buildFactsHead,
  writeFactStore,
  saveBase,
  loadBase,
  computeDelta,
  type FactsHead,
} from '../../incremental/fact-store.js'
import {
  shouldCompact,
  compactFactStore,
  DEFAULT_COMPACTION_CONFIG,
} from '../../incremental/fact-store-compaction.js'

export interface AnalyzeOpts {
  config?: string
  root?: string
  output?: string
  detectors?: string
  save?: boolean
  map?: boolean
  incremental?: boolean
  withRuntime?: string
  // ADR-027 Phase 3 — mode review : analyse à <base> ET <head>, produit
  // un delta de fact_ids. Format : "<base>..<head>" (deux refs git).
  pr?: string
}

export async function runAnalyzeCommand(opts: AnalyzeOpts): Promise<void> {
  // ADR-027 Phase 3 — mode review (PR) : analyse à <base> et <head>,
  // sort un delta de fact_ids. Court-circuite le flow `analyze` standard.
  if (opts.pr) {
    await runPrCommand(opts)
    return
  }

  const config = await loadConfig(opts)

  const incremental = Boolean(opts.incremental)

  console.log(chalk.bold('\n🔍 CodeGraph — Analyzing...\n'))
  console.log(`  Root:       ${config.rootDir}`)
  console.log(`  Include:    ${config.include.join(', ')}`)
  console.log(`  Detectors:  ${config.detectors.join(', ')} ${chalk.dim('(graph base)')}`)
  if (incremental) console.log(`  Mode:       ${chalk.cyan('incremental (Salsa)')}`)
  console.log()

  const result = await analyze(config, { incremental })
  const { snapshot, timing } = result

  printAnalyzeStats(snapshot)
  printExportsSummary(snapshot)
  printTiming(timing)
  printDetectorsRunSummary(timing)

  if (opts.save !== false) {
    await persistAnalyzeOutputs(opts, snapshot, config, timing, result.files, result.astFactsBundle)
  } else {
    process.stdout.write(JSON.stringify(snapshot, null, 2))
  }

  if (opts.withRuntime) {
    await runRuntimeProbeWrapper(opts.withRuntime)
  }
}

// ADR-027
/**
 * Mode review (Phase 3) — analyse à `<base>` (worktree git détaché) +
 * `<head>` (working tree courant), calcule le delta des fact_ids, sort
 * un résumé markdown structuré.
 *
 * Cache : `<base>.json` dans `.codegraph/facts.bases/` — la 2e PR
 * partant du même base ne refait pas l'analyze à `<base>`.
 */
async function runPrCommand(opts: AnalyzeOpts): Promise<void> {
  const config = await loadConfig(opts)
  const prSpec = opts.pr!
  const match = prSpec.match(/^(.+?)\.\.(.+)$/)
  if (!match) {
    console.error(chalk.red(`Invalid --pr format: "${prSpec}". Expected "<base>..<head>" (e.g. "main..HEAD").`))
    process.exit(1)
  }
  const [, baseRef, headRef] = match

  const { execSync } = await import('node:child_process')
  const baseSha = resolveSha(execSync, config.rootDir, baseRef)
  const headSha = headRef === 'HEAD' || headRef === '' ? 'WORKING_TREE' : resolveSha(execSync, config.rootDir, headRef)

  console.log(chalk.bold(`\n🔀 CodeGraph PR mode — ${baseRef}..${headRef}\n`))
  console.log(`  base: ${baseSha}`)
  console.log(`  head: ${headSha}`)

  // 1. Cache hit ? Sinon, analyze à <base>.
  let baseHead = await loadBase(config.snapshotDir, baseSha)
  if (baseHead) {
    console.log(chalk.dim(`  ✓ base cached (factSet=${baseHead.factSetHash.slice(0, 12)}…)`))
  } else {
    console.log(chalk.cyan(`  ⓘ analyzing base ${baseRef} in detached worktree…`))
    baseHead = await analyzeAtRefForFacts(execSync, config, baseSha)
    await saveBase(config.snapshotDir, baseSha, baseHead)
    console.log(chalk.green(`  ✓ base analyzed + cached (factSet=${baseHead.factSetHash.slice(0, 12)}…)`))
  }

  // 2. Analyze HEAD (= working tree). Réutilise le `analyze --incremental`
  // standard puis lit le head matérialisé.
  console.log(chalk.cyan(`  ⓘ analyzing head…`))
  const result = await analyze(config, { incremental: true })
  if (!result.astFactsBundle) {
    console.error(chalk.red('  ✗ no AstFactsBundle — Datalog runner failed (check logs above)'))
    process.exit(1)
  }
  const headOut = buildFactsHead(result.astFactsBundle, {
    generatedAt: result.snapshot.generatedAt,
    baseSha: headSha,
  })

  // 3. Delta.
  const delta = computeDelta(baseHead, headOut.head)
  printPrDelta(delta, baseRef, headRef)
}

async function analyzeAtRefForFacts(
  execSync: typeof import('node:child_process').execSync,
  config: import('../../core/types.js').CodeGraphConfig,
  sha: string,
): Promise<FactsHead> {
  const tmpDir = path.join(config.rootDir, '.codegraph', `_worktree_pr_${Date.now()}`)
  try {
    execSync(`git worktree add --detach "${tmpDir}" ${sha}`, {
      cwd: config.rootDir, encoding: 'utf-8', stdio: 'pipe',
    })
    const tmpConfig: import('../../core/types.js').CodeGraphConfig = {
      ...config,
      rootDir: tmpDir,
      snapshotDir: path.join(tmpDir, '.codegraph'),
    }
    const result = await analyze(tmpConfig, { incremental: false })
    if (!result.astFactsBundle) {
      throw new Error('worktree analyze did not produce an AstFactsBundle')
    }
    return buildFactsHead(result.astFactsBundle, {
      generatedAt: result.snapshot.generatedAt,
      baseSha: sha,
    }).head
  } finally {
    try {
      execSync(`git worktree remove --force "${tmpDir}"`, {
        cwd: config.rootDir, encoding: 'utf-8', stdio: 'pipe',
      })
    } catch {
      try { await fs.rm(tmpDir, { recursive: true }) } catch { /* nothing */ }
      try { execSync(`git worktree prune`, { cwd: config.rootDir, stdio: 'pipe' }) } catch { /* nothing */ }
    }
  }
}

function resolveSha(
  execSync: typeof import('node:child_process').execSync,
  rootDir: string,
  ref: string,
): string {
  try {
    return execSync(`git rev-parse ${ref}`, { cwd: rootDir, encoding: 'utf-8' }).trim()
  } catch {
    console.error(chalk.red(`Cannot resolve git ref: ${ref}`))
    process.exit(1)
  }
}

function printPrDelta(
  delta: import('../../incremental/fact-store.js').FactsDelta,
  baseRef: string,
  headRef: string,
): void {
  console.log()
  console.log(chalk.bold(`  Delta ${baseRef}..${headRef}:`))
  console.log(`    base factSet: ${delta.baseFactSetHash.slice(0, 12)}…`)
  console.log(`    head factSet: ${delta.headFactSetHash.slice(0, 12)}…`)
  console.log(`    ${chalk.green('+ added:')}   ${delta.added.length} facts`)
  console.log(`    ${chalk.red('- removed:')} ${delta.removed.length} facts`)

  const breakdown = new Map<string, { added: number; removed: number }>()
  for (const a of delta.added) {
    const e = breakdown.get(a.relation) ?? { added: 0, removed: 0 }
    e.added++
    breakdown.set(a.relation, e)
  }
  for (const r of delta.removed) {
    const e = breakdown.get(r.relation) ?? { added: 0, removed: 0 }
    e.removed++
    breakdown.set(r.relation, e)
  }
  if (breakdown.size === 0) return
  console.log()
  console.log(chalk.dim(`  Per relation:`))
  for (const [rel, c] of [...breakdown.entries()].sort()) {
    if (c.added === 0 && c.removed === 0) continue
    console.log(`    ${rel.padEnd(40)} ${chalk.green('+' + c.added)} ${chalk.red('-' + c.removed)}`)
  }
  console.log()
}

/**
 * Wrapper sur `liby-runtime-graph probe -- <cmd>` pour le flag --with-runtime.
 * Lance le binaire si dispo dans node_modules, sinon log un hint.
 */
async function runRuntimeProbeWrapper(cmdString: string): Promise<void> {
  const { spawn } = await import('node:child_process')
  const args = cmdString.split(' ').filter(Boolean)
  if (args.length === 0) {
    console.log(chalk.yellow('  ⚠ --with-runtime needs a command, e.g. "npm test"'))
    return
  }
  console.log(chalk.cyan(`\n  ⓘ running runtime probe: ${cmdString}`))
  await new Promise<void>((resolve) => {
    const child = spawn('npx', ['liby-runtime-graph', 'probe', '--cpu-profile', ...args], {
      stdio: 'inherit',
      shell: false,
    })
    child.on('exit', () => resolve())
  })
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

/**
 * Affiche un recap court des detecteurs reellement executes (au-dela des
 * 6 base detectors listes en tete d'output). L'analyzer enchaine ~60+
 * detectors composite/quality/security en aval — sans cette ligne, le
 * user croit que `Detectors:` represente la totalite alors que c'est
 * juste la base graphe.
 */
function printDetectorsRunSummary(timing: import('../../core/analyzer.js').AnalyzeResult['timing']): void {
  const detectors = Object.keys(timing.detectors)
  if (detectors.length === 0) return
  console.log(chalk.dim(`  ${detectors.length} detectors total ran (graph base + composite/quality/security/etc).`))
  console.log(chalk.dim(`  Run \`codegraph detectors\` for the full list with descriptions.\n`))
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
  timing: import('../../core/analyzer.js').AnalyzeResult['timing'],
  files: readonly string[],
  astFactsBundle?: import('../../datalog-detectors/ast-facts/types.js').AstFactsBundle,
): Promise<void> {
  // ADR-027 — `--output <path>` reste l'override raw-JSON pour les
  // pipelines externes qui s'attendent à un fichier autonome. Sinon
  // on écrit le format v2 unifié (`snapshot.json` + sidecar meta).
  let factSetHash: string | undefined
  if (opts.output) {
    await fs.mkdir(path.dirname(opts.output), { recursive: true })
    await fs.writeFile(opts.output, JSON.stringify(snapshot, null, 2))
    console.log(chalk.green(`  ✓ Snapshot saved: ${opts.output}\n`))
  } else {
    const outPath = await defaultSnapshotPath(config)
    const { hash: inputHash, ctx } = await computeInputHash(config, files)

    // ADR-027 Phase 3 — matérialise le content-addressed fact store
    // depuis l'AstFactsBundle agrégé. Skip silencieusement si pas de
    // bundle (legacy mode pré-Datalog). Le store est append-only,
    // le head réécrit complet à chaque analyze.
    if (astFactsBundle) {
      const t0 = performance.now()
      const { head, records } = buildFactsHead(astFactsBundle, {
        generatedAt: snapshot.generatedAt,
        baseSha: snapshot.commitHash,
      })
      const { added, existing } = await writeFactStore(config.snapshotDir, head, records)
      factSetHash = head.factSetHash
      const ms = (performance.now() - t0).toFixed(0)
      console.log(chalk.green(
        `  ✓ Fact store: ${added} added / ${existing} dedup (factSet=${factSetHash.slice(0, 12)}…, ${ms}ms)\n`,
      ))

      // ADR-028 — auto-trigger compaction si seuils dépassés. Lit la
      // config user `factStore.{maxOrphanRatio,maxSizeBytes,keepBases}`
      // si présente. Best-effort : un échec ne casse pas l'analyze.
      try {
        const userCfg = (config as unknown as {
          factStore?: { maxOrphanRatio?: number; maxSizeBytes?: number; keepBases?: number }
        }).factStore
        const compactCfg = {
          maxOrphanRatio: userCfg?.maxOrphanRatio ?? DEFAULT_COMPACTION_CONFIG.maxOrphanRatio,
          maxSizeBytes: userCfg?.maxSizeBytes ?? DEFAULT_COMPACTION_CONFIG.maxSizeBytes,
          keepBases: userCfg?.keepBases ?? DEFAULT_COMPACTION_CONFIG.keepBases,
        }
        const stats = await shouldCompact(config.snapshotDir, compactCfg)
        if (stats?.shouldCompact) {
          const cResult = await compactFactStore(config.snapshotDir, compactCfg)
          const freedMb = (cResult.freedBytes / 1024 / 1024).toFixed(1)
          console.log(chalk.dim(
            `  ✓ Auto-compacted store (${stats.reason}): -${cResult.removed} facts, ` +
            `freed ${freedMb} MB (${cResult.durationMs.toFixed(0)}ms)\n`,
          ))
        }
      } catch (err) {
        console.error(chalk.yellow(`  ⚠ Compaction skipped: ${err instanceof Error ? err.message : String(err)}`))
      }
    }

    const meta: SnapshotMeta = {
      version: SNAPSHOT_VERSION,
      inputHash,
      generatedAt: snapshot.generatedAt,
      baseSha: snapshot.commitHash,
      fileCount: ctx.fileCount,
      toolingVersion: ctx.toolingVersion,
      factSetHash,
    }
    await writeStoredSnapshot(config.snapshotDir, meta, snapshot)
    console.log(chalk.green(`  ✓ Snapshot saved: ${outPath} (inputHash: ${inputHash.slice(0, 12)}…)\n`))

    // Migration douce — supprime progressivement les snapshot-<ts>-<sha>.json
    // accumulés (Phase 1). On garde 2 plus récents pour rollback manuel.
    const prunedLegacy = await pruneLegacySnapshots(config.snapshotDir, 2)
    if (prunedLegacy > 0) {
      console.log(chalk.dim(`  ✓ Pruned ${prunedLegacy} legacy snapshot(s) (kept 2 for rollback)\n`))
    }
  }

  // Side-channel pour `codegraph detectors` : timing du dernier run, hors
  // snapshot.json (qui est un format public versionne ADR-009 — on
  // n'ajoute pas de champs internes dedans).
  const timingPath = path.join(config.snapshotDir, 'last-run-timing.json')
  await fs.writeFile(timingPath, JSON.stringify({
    generatedAt: snapshot.generatedAt,
    detectors: timing.detectors,
    fileDiscovery: timing.fileDiscovery,
    graphBuild: timing.graphBuild,
    total: timing.total,
  }, null, 2))

  // Dérivatifs ADR-009 : synopsis.json + synopsis-level{1,2,3}.md.
  // Lien 1+2 ADR-toolkit : collecte les marqueurs `// ADR-NNN` hors-builder
  // pour préserver la pureté (cf. ADR-009 — projection déterministe).
  const adrMarkers = await collectAdrMarkers(config.rootDir)
  const synopsis = buildSynopsis(snapshot, { adrMarkers })
  // Si --output a été utilisé, les dérivés vivent à côté du fichier custom
  // pour préserver le comportement legacy ; sinon ils vont dans le
  // snapshotDir canonique (ADR-027).
  const snapDir = opts.output ? path.dirname(opts.output) : config.snapshotDir
  await fs.writeFile(path.join(snapDir, 'synopsis.json'), JSON.stringify(synopsis, null, 2))
  const l1 = renderLevel1(synopsis)
  await fs.writeFile(path.join(snapDir, 'synopsis-level1.md'), l1)
  await fs.writeFile(path.join(snapDir, 'synopsis.md'), l1)
  await fs.writeFile(path.join(snapDir, 'synopsis-level2.md'), renderLevel2(synopsis))
  // Skip level3 pour les containers de moins de 3 fichiers — un singleton
  // (ex: `_root` quand un seul config présent, ou un sous-dir avec 1-2 files)
  // produit un .md sans valeur narrative. Seuil 3 = sortir de la singularité
  // accidentelle (cf. invariant load-bearing toolkit).
  const level3Containers = synopsis.containers.filter((c) => c.fileCount >= 3)
  await Promise.all(
    level3Containers.map((c) =>
      fs.writeFile(
        path.join(snapDir, `synopsis-level3-${c.id}.md`),
        renderLevel3(synopsis, c.id),
      ),
    ),
  )
  console.log(chalk.green(
    `  ✓ Synopsis written: synopsis.json + ${level3Containers.length + 3} markdown files in ${snapDir}\n`,
  ))

  // Auto-baseline pour NO-NEW-ARTICULATION-POINT. Au premier run, capture
  // les cut-vertex actuels dans .codegraph/articulation-baseline.json
  // (ratchet implicit). Aux runs suivants, charge le baseline pour emettre
  // les facts grandfather. Cf. core/articulation-baseline.ts + F-201.
  try {
    const apFiles = (snapshot.articulationPoints ?? []).map((ap) => ap.file)
    const { grandfathered, created } = await resolveGrandfatheredArticulations(
      config.rootDir, apFiles, snapDir,
    )
    snapshot.articulationGrandfathered = [...grandfathered].sort()
    if (created) {
      console.log(chalk.dim(
        `  ✓ Articulation baseline created: ${grandfathered.size} cut-vertex(es) grandfathered ` +
        `(commit .codegraph/articulation-baseline.json to share with the team).\n`,
      ))
    }
  } catch (err) {
    console.error(
      chalk.yellow(`  ⚠ Articulation baseline resolve failed: ${err instanceof Error ? err.message : String(err)}`),
    )
  }

  // Datalog facts derivative — un fichier .facts par relation + schema.dl.
  // Régen à chaque analyze (cf. ADR-022).
  // Workspace paths : passes pour skip les paires near-duplicate /
  // copy-paste-fork qui vivent dans 2 workspaces distincts (P3 — adapter
  // pattern intentionnel, cf. tanstack-query react-query/vue-query/...).
  try {
    const wsMap = await detectWorkspaces(config.rootDir)
    const factsResult = await exportFacts(snapshot, {
      outDir: path.join(snapDir, 'facts'),
      workspacePaths: wsMap.paths,
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
