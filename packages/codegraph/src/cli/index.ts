#!/usr/bin/env node

/**
 * CodeGraph CLI
 *
 * ⚠ GOD FILE WARNING (2176 LOC, 24+ commands) — Split planifié :
 *   Ce fichier monolithique est à découper en `cli/commands/<name>.ts` —
 *   un module par command group. Le pattern (PoC done) : extraire les
 *   action handlers dans des modules dédiés, garder uniquement les
 *   `.command()` registrations + option declarations ici.
 *
 *   Ordre de migration (par taille décroissante) :
 *     - datalog-check (137 LOC)   → cli/commands/datalog-check.ts
 *     - diff (230 LOC)            → cli/commands/diff.ts
 *     - analyze (170 LOC)         → cli/commands/analyze.ts
 *     - check (78 LOC)            → cli/commands/check.ts
 *     - memory subcmds (135 LOC)  → cli/commands/memory.ts
 *
 *   Chaque extraction = 1 commit séparé pour facilité review + git
 *   blame préservation. Voir `cli/commands/_template.ts` pour le shape.
 *
 * Commands actuels :
 *   analyze, watch, map, synopsis, orphans, arch-check, reach,
 *   affected, exports, taint, dsm, deps, diff, check, facts,
 *   datalog-check, memory {list,mark,obsolete,delete,prune,export,where},
 *   serve
 */

import { Command } from 'commander'
import chalk from 'chalk'
import * as fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze } from '../core/analyzer.js'
import { CodeGraph } from '../core/graph.js'
import type { CodeGraphConfig, GraphSnapshot } from '../core/types.js'
import { buildSynopsis, renderLevel1, renderLevel2, renderLevel3 } from '../synopsis/builder.js'
import { collectAdrMarkers } from '../synopsis/adr-markers.js'
import { buildMap } from '../map/builder.js'
import { runCheck, ALL_RULES } from '../check/index.js'
import { findReachablePaths, globToRegex } from '../graph/reachability.js'
import { computeDsm } from '../graph/dsm.js'
import { renderDsm, aggregateByContainer } from '../map/dsm-renderer.js'
import { exportFacts } from '../facts/index.js'
import { CodeGraphWatcher } from '../incremental/watcher.js'
import {
  loadMemoryRaw, addEntry, markObsolete, deleteEntry, recall,
  memoryPathFor,
} from '../memory/store.js'
// Shared helpers — extraits du god-file (P2a split).
import {
  loadConfig, loadSnapshot, defaultSnapshotPath, pruneSnapshots,
  formatHealth, exists, analyzeAtRef,
} from './_shared.js'
// Extracted commands (P2a god-file split — commands moved to cli/commands/)
import { runMemoryWhere } from './commands/memory-where.js'
import { runAnalyzeCommand } from './commands/analyze.js'
import { runDiffCommand } from './commands/diff.js'
import { runDatalogCheckCommand } from './commands/datalog-check.js'
import { runCrossCheckCommand } from './commands/cross-check.js'
import { runAffectedCommand } from './commands/affected.js'
import { runDepsCommand } from './commands/deps.js'
import { runCheckCommand } from './commands/check.js'
import { runExportsCommand } from './commands/exports.js'
import { runArchCheckCommand } from './commands/arch-check.js'
import { runServeCommand } from './commands/serve.js'

const program = new Command()

const PKG_VERSION: string = (() => {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const pkgPath = path.resolve(here, '../../package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

program
  .name('codegraph')
  .description('Visual dependency graph for AI-supervised codebases')
  .version(PKG_VERSION)

// ─── detectors ────────────────────────────────────────────────────────────

program
  .command('detectors')
  .description('List detectors that ran in the latest analyze, with timings')
  .action(async () => {
    const config = await loadConfig({})
    const snapPath = await defaultSnapshotPath(config)
    const timingPath = path.join(path.dirname(snapPath), 'last-run-timing.json')
    const raw = await fs.readFile(timingPath, 'utf-8').catch(() => '')
    if (!raw) {
      console.log(chalk.yellow('No detector timing found. Run `codegraph analyze` first.'))
      return
    }
    const data = JSON.parse(raw) as { detectors?: Record<string, number>; total?: number }
    const entries = Object.entries(data.detectors ?? {}).sort((a, b) => b[1] - a[1])
    if (entries.length === 0) {
      console.log(chalk.yellow('Timing file empty — re-run analyze.'))
      return
    }
    console.log(chalk.bold(`\n${entries.length} detectors ran (sorted by cost):\n`))
    for (const [name, ms] of entries) {
      console.log(`  ${name.padEnd(30)} ${chalk.dim((ms as number).toFixed(0).padStart(5) + 'ms')}`)
    }
    if (typeof data.total === 'number') {
      console.log(chalk.dim(`\n  Total analyze: ${data.total.toFixed(0)}ms`))
    }
  })

// ─── analyze ──────────────────────────────────────────────────────────────

program
  .command('analyze')
  .description('Run all detectors and generate a snapshot')
  .option('-c, --config <path>', 'Path to codegraph config file')
  // Pas de default ici : permet à loadConfig de distinguer "non passé"
  // (laisser le rootDir de la config gagner) de "passé explicitement"
  // (override le rootDir pour analyser un autre checkout).
  .option('-r, --root <path>', 'Project root directory (overrides config rootDir)')
  .option('-o, --output <path>', 'Output snapshot file path')
  .option('-d, --detectors <names>', 'Comma-separated detector names to run')
  .option('--no-save', 'Print to stdout instead of saving to file')
  .option('--map', 'Also write MAP.md (structural map) at project root')
  .option('--incremental',
    'Use Salsa-cached path (Phase 1). Sub-2x speedup on warm runs in the ' +
    'same process. Outputs identical to legacy mode (verified bit-for-bit ' +
    'on Sentinel).')
  .option('--with-runtime <cmd>',
    'Run analyze + spawn runtime probe via `liby-runtime-graph probe -- <cmd>`. ' +
    'Captures statique × runtime en une commande. Exemple : ' +
    '--with-runtime "npm test" ou --with-runtime "node app.mjs".')
  .action(async (opts) => {
    await runAnalyzeCommand(opts)
    if (opts.withRuntime) {
      await runRuntimeProbeWrapper(opts.withRuntime)
    }
  })

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

// ─── watch ────────────────────────────────────────────────────────────────

program
  .command('watch')
  .description(
    'Watch filesystem and recompute snapshot incrementally on every change. ' +
    'Maintains the Salsa cache + ts-morph Project in RAM for sub-50ms warm ' +
    'recomputes (vs ~10s cold via CLI). Cible : dev local, IDE/dashboard ' +
    'integration. Ctrl+C pour arrêter.',
  )
  .option('-c, --config <path>', 'Path to codegraph config file')
  .option('-r, --root <path>', 'Project root directory (overrides config rootDir)')
  .option('--debounce <ms>', 'Debounce ms before recompute (default 50)', '50')
  .action(async (opts) => {
    const config = await loadConfig(opts)
    const debounceMs = parseInt(opts.debounce, 10)

    console.log(chalk.bold('\n👁  CodeGraph — Watching\n'))
    console.log(`  Root:     ${config.rootDir}`)
    console.log(`  Include:  ${config.include.join(', ')}`)
    console.log(`  Debounce: ${debounceMs}ms`)
    console.log(chalk.dim('  (Ctrl+C to stop)\n'))

    const watcher = new CodeGraphWatcher(config, {
      debounceMs,
      onUpdate: ({ changedFiles, durationMs }) => {
        const filesPart = changedFiles.length === 0
          ? chalk.dim('initial')
          : changedFiles.length === 1
            ? changedFiles[0]
            : `${changedFiles[0]} (+${changedFiles.length - 1} more)`
        const ms = durationMs.toFixed(0)
        const msColor = durationMs < 100 ? chalk.green : durationMs < 1000 ? chalk.yellow : chalk.red
        console.log(`  ${chalk.cyan('•')} ${filesPart} ${msColor(`${ms}ms`)}`)
      },
      onError: (err) => {
        console.error(chalk.red(`  ✗ recompute failed: ${err}`))
      },
    })

    process.on('SIGINT', () => {
      console.log(chalk.dim('\n  Stopping... (saving cache)'))
      void watcher.stop().then(() => process.exit(0))
    })

    await watcher.start()
    // Bloque le process en idle (les fs.watch handlers gardent l'event loop alive)
    await new Promise(() => {})
  })

// ─── map ──────────────────────────────────────────────────────────────────

program
  .command('map')
  .description('Generate a structural map MAP.md from an existing snapshot')
  .argument('[snapshot]', 'Path to snapshot JSON file (default: latest)')
  .option('-c, --config <path>', 'Path to codegraph config file')
  .option('-o, --output <path>', 'Output path (default: <rootDir>/MAP.md)')
  .option('--stdout', 'Print to stdout instead of writing to file')
  .option('--min-indegree <n>', 'Min in-degree for a file fiche (default 2)', '2')
  .option('--max-modules <n>', 'Cap number of module fiches (default 200)', '200')
  .action(async (snapshotPath, opts) => {
    const snapshot = await loadSnapshot(snapshotPath, opts)
    const config = await loadConfig(opts)
    const content = buildMap(snapshot, {
      minIndegree: parseInt(opts.minIndegree, 10),
      maxModulesInFiches: parseInt(opts.maxModules, 10),
      concerns: config.concerns,
    })

    if (opts.stdout) {
      process.stdout.write(content)
      return
    }
    const outPath = opts.output ?? path.join(config.rootDir, 'MAP.md')
    await fs.mkdir(path.dirname(outPath), { recursive: true })
    await fs.writeFile(outPath, content)
    const approxTokens = Math.round(content.length / 4)
    console.log(chalk.green(`✓ MAP.md written: ${outPath} (~${approxTokens} tokens, ${content.length} chars)`))
  })

// ─── synopsis ─────────────────────────────────────────────────────────────

program
  .command('synopsis')
  .description('Generate C4 mental map (Level 1/2/3) from an existing snapshot')
  .argument('[snapshot]', 'Path to snapshot JSON file (default: latest)')
  .option('-c, --config <path>', 'Path to codegraph config file')
  .option('-l, --level <n>', 'Level to render: 1 (context), 2 (containers), 3 (components)', '1')
  .option('--container <id>', 'Container id for Level 3 (e.g. sentinel-core)')
  .option('--format <fmt>', 'Output format: md | json', 'md')
  .action(async (snapshotPath, opts) => {
    const snapshot = await loadSnapshot(snapshotPath, opts)
    const cfg = await loadConfig(opts)
    const adrMarkers = await collectAdrMarkers(cfg.rootDir)
    const synopsis = buildSynopsis(snapshot, { adrMarkers })

    if (opts.format === 'json') {
      process.stdout.write(JSON.stringify(synopsis, null, 2))
      return
    }

    const level = parseInt(opts.level, 10)
    let out: string
    if (level === 1) out = renderLevel1(synopsis)
    else if (level === 2) out = renderLevel2(synopsis)
    else if (level === 3) {
      if (!opts.container) {
        console.error(chalk.red('--container <id> required for Level 3'))
        console.error(chalk.dim(`Available: ${synopsis.containers.map(c => c.id).join(', ')}`))
        process.exit(1)
      }
      out = renderLevel3(synopsis, opts.container)
    } else {
      console.error(chalk.red(`Invalid level: ${opts.level} (expected 1, 2, or 3)`))
      process.exit(1)
    }

    process.stdout.write(out)
  })

// ─── orphans ──────────────────────────────────────────────────────────────

program
  .command('orphans')
  .description('List orphan nodes from a snapshot')
  .argument('[snapshot]', 'Path to snapshot JSON file')
  .option('-c, --config <path>', 'Path to codegraph config file')
  .option('--json', 'Output as JSON')
  .action(async (snapshotPath, opts) => {
    const snapshot = await loadSnapshot(snapshotPath, opts)
    const orphans = snapshot.nodes.filter(n => n.type === 'file' && n.status === 'orphan')
    const uncertain = snapshot.nodes.filter(n => n.type === 'file' && n.status === 'uncertain')

    if (opts.json) {
      console.log(JSON.stringify({ orphans, uncertain }, null, 2))
      return
    }

    console.log(chalk.bold(`\n🔍 Orphan Report\n`))
    console.log(`  Total files:    ${snapshot.stats.totalFiles}`)
    console.log(`  Health score:   ${formatHealth(snapshot.stats.healthScore)}`)
    console.log()

    if (orphans.length === 0) {
      console.log(chalk.green('  No orphans found! 🎉\n'))
    } else {
      console.log(chalk.yellow(`  ${orphans.length} orphan(s):\n`))
      for (const node of orphans.sort((a, b) => a.id.localeCompare(b.id))) {
        const tags = node.tags.length > 0 ? chalk.dim(` [${node.tags.join(', ')}]`) : ''
        console.log(`    ${chalk.red('●')} ${node.id}${tags}`)
      }
      console.log()
    }

    if (uncertain.length > 0) {
      console.log(chalk.dim(`  ${uncertain.length} uncertain (only unresolved incoming):\n`))
      for (const node of uncertain.sort((a, b) => a.id.localeCompare(b.id))) {
        console.log(`    ${chalk.yellow('◐')} ${node.id}`)
      }
      console.log()
    }
  })

// ─── arch-check ───────────────────────────────────────────────────────────

program
  .command('arch-check')
  .description('Validate architecture rules (arch-rules.json) against the current snapshot')
  .option('-c, --config <path>', 'Path to codegraph config file')
  .option('-r, --rules <path>', 'Path to arch-rules.json (default: <rootDir>/arch-rules.json or <rootDir>/codegraph/arch-rules.json)')
  .option('--json', 'Output violations as JSON')
  .action(async (opts) => {
    await runArchCheckCommand(opts)
  })

// ─── reach ────────────────────────────────────────────────────────────────

program
  .command('reach')
  .description('Find transitive import paths from <from> to <to> (glob patterns)')
  .argument('<from>', 'Source glob (ex: "sentinel-core/src/kernel/**")')
  .argument('<to>', 'Target glob (ex: "sentinel-core/src/packs/**")')
  .option('-c, --config <path>', 'Path to codegraph config file')
  .option('--json', 'Output paths as JSON')
  .option('--max <n>', 'Max paths to print (default 20)', '20')
  .action(async (fromGlob: string, toGlob: string, opts) => {
    const snapshot = await loadSnapshot(undefined, opts)
    const fromRe = globToRegex(fromGlob)
    const toRe = globToRegex(toGlob)
    const files = snapshot.nodes.filter((n) => n.type === 'file').map((n) => n.id)
    const sources = new Set(files.filter((f) => fromRe.test(f)))
    const targets = new Set(files.filter((f) => toRe.test(f)))

    if (sources.size === 0) {
      console.error(chalk.yellow(`  No files match <from> glob: ${fromGlob}`))
      return
    }
    if (targets.size === 0) {
      console.error(chalk.yellow(`  No files match <to> glob: ${toGlob}`))
      return
    }

    const paths = findReachablePaths(sources, targets, snapshot.edges)

    if (opts.json) {
      console.log(JSON.stringify({ from: fromGlob, to: toGlob, paths }, null, 2))
      return
    }

    console.log(chalk.bold(`\n  Reachability ${fromGlob} → ${toGlob}\n`))
    console.log(`  Sources: ${sources.size} files · Targets: ${targets.size} files`)
    if (paths.length === 0) {
      console.log(chalk.green(`  ✓ No transitive path found. ${fromGlob} cannot reach ${toGlob}.\n`))
      return
    }

    const max = parseInt(opts.max, 10)
    console.log(chalk.red(`  ✗ ${paths.length} transitive path(s) found:\n`))
    for (const p of paths.slice(0, max)) {
      console.log(`    ${p.path.join(' → ')}`)
    }
    if (paths.length > max) {
      console.log(chalk.dim(`    … +${paths.length - max} more (use --max to show)`))
    }
    console.log()
  })

// ─── affected ────────────────────────────────────────────────────────────

program
  .command('affected')
  .description('BFS reverse depuis les fichiers donnés — liste tout ce qui est impacté transitivement')
  .argument('[files...]', 'Files modifiés (relatifs au repo). Si vide, lit `git diff --name-only HEAD`')
  .option('-c, --config <path>', 'Path to codegraph config file')
  .option('--include-indirect', 'Inclure event/queue/db-table edges en plus des imports')
  .option('--max-depth <n>', 'Profondeur BFS max (défaut: pas de cap)', '0')
  .option('--tests-only', 'Output uniquement les fichiers tests parmi les affected')
  .option('--tests-glob <pattern>', 'Scanne ces fichiers tests à la volée (regex import) pour les croiser avec affected. Ex: "sentinel-core/tests/**/*.test.ts". Nécessaire si la config codegraph exclut les tests du snapshot.')
  .option('--json', 'Output JSON')
  .action(async (files: string[], opts) => {
    await runAffectedCommand(files, opts)
  })

// ─── exports ─────────────────────────────────────────────────────────────

program
  .command('exports')
  .description('List unused exports (dead code candidates)')
  .argument('[snapshot]', 'Path to snapshot JSON file')
  .option('-c, --config <path>', 'Path to codegraph config file')
  .option('-f, --file <path>', 'Show exports for a specific file')
  .option('--all', 'Show all exports, not just unused')
  .option('--json', 'Output as JSON')
  .action(async (snapshotPath, opts) => {
    await runExportsCommand(snapshotPath, opts)
  })

// ─── taint ────────────────────────────────────────────────────────────────

program
  .command('taint')
  .description('Display taint violations (source → sink without sanitizer) from the latest snapshot')
  .argument('[snapshot]', 'Path to snapshot JSON file (default: latest)')
  .option('-c, --config <path>', 'Path to codegraph config file')
  .option('--json', 'Output as JSON')
  .option('--severity <level>', 'Filter by min severity: critical | high | medium | low', 'low')
  .action(async (snapshotPath, opts) => {
    const snapshot = await loadSnapshot(snapshotPath, opts)
    const violations = snapshot.taintViolations ?? []
    const order = ['low', 'medium', 'high', 'critical']
    const minIdx = order.indexOf(opts.severity)
    const filtered = violations.filter((v) => order.indexOf(v.severity) >= minIdx)

    if (opts.json) {
      console.log(JSON.stringify(filtered, null, 2))
      process.exit(filtered.length > 0 ? 1 : 0)
    }

    console.log(chalk.bold('\n  Taint Analysis\n'))

    if (!snapshot.taintViolations) {
      console.log(chalk.yellow(`  ⚠ No taint data in snapshot. Enable taint in config:`))
      console.log(chalk.dim(`      "detectorOptions": { "taint": { "enabled": true } }`))
      console.log(chalk.dim(`  And provide a taint-rules.json at project root.\n`))
      process.exit(0)
    }

    if (filtered.length === 0) {
      console.log(chalk.green('  ✓ No violations at this severity.\n'))
      process.exit(0)
    }

    const counts = { critical: 0, high: 0, medium: 0, low: 0 }
    for (const v of filtered) counts[v.severity]++
    console.log(
      `  ${chalk.red(String(counts.critical))} critical · ` +
      `${chalk.magenta(String(counts.high))} high · ` +
      `${chalk.yellow(String(counts.medium))} medium · ` +
      `${chalk.dim(String(counts.low))} low`,
    )
    console.log()

    for (const v of filtered) {
      const sevColor = v.severity === 'critical' ? chalk.red
                     : v.severity === 'high' ? chalk.magenta
                     : v.severity === 'medium' ? chalk.yellow
                     : chalk.dim
      console.log(`  ${sevColor('✗ ' + v.severity.toUpperCase().padEnd(8))} ${chalk.bold(v.sourceName)} → ${chalk.bold(v.sinkName)}`)
      console.log(chalk.dim(`      ${v.file}:${v.line}  ${v.symbol ? `(${v.symbol})` : ''}`))
      for (const step of v.chain) {
        const icon = step.kind === 'source' ? '┌' : step.kind === 'sink' ? '└' : '│'
        console.log(chalk.dim(`      ${icon} L${step.line}  ${step.detail}`))
      }
      console.log()
    }

    process.exit(filtered.length > 0 ? 1 : 0)
  })

// ─── dsm ──────────────────────────────────────────────────────────────────

program
  .command('dsm')
  .description('Render a Dependency Structure Matrix (SCC-partitioned, topo-ordered)')
  .argument('[snapshot]', 'Path to snapshot JSON file (default: latest)')
  .option('-c, --config <path>', 'Path to codegraph config file')
  .option('--granularity <level>', 'file | container (default: container)', 'container')
  .option('--depth <n>', 'Container path depth (segments from root) — applies when --granularity=container', '3')
  .option('--edge-types <types>', 'Comma-separated edge types (default: import)', 'import')
  .option('--json', 'Output as JSON {order, matrix, backEdges, levels}')
  .option('-o, --output <path>', 'Write markdown to file instead of stdout')
  .action(async (snapshotPath, opts) => {
    const snapshot = await loadSnapshot(snapshotPath, opts)
    const edgeTypes = new Set((opts.edgeTypes as string).split(',').map((s: string) => s.trim()))

    const fileNodes = snapshot.nodes.filter((n) => n.type === 'file').map((n) => n.id)
    const rawEdges = snapshot.edges
      .filter((e) => edgeTypes.has(e.type))
      .map((e) => ({ from: e.from, to: e.to }))

    let nodes = fileNodes
    let edges = rawEdges
    if (opts.granularity === 'container') {
      const depth = parseInt(opts.depth, 10)
      const agg = aggregateByContainer(fileNodes, rawEdges, depth)
      nodes = agg.nodes
      edges = agg.edges
    }

    const dsm = computeDsm(nodes, edges)

    if (opts.json) {
      console.log(JSON.stringify(dsm, null, 2))
      return
    }

    const md = renderDsm(dsm, {
      title: `DSM — ${opts.granularity === 'container' ? `container (depth=${opts.depth})` : 'file-level'} · ${dsm.order.length} nodes · ${dsm.backEdges.length} back-edges`,
    })

    if (opts.output) {
      await fs.writeFile(opts.output, md)
      console.log(chalk.green(`✓ DSM written: ${opts.output}`))
      return
    }

    process.stdout.write(md)
  })

// ─── deps ─────────────────────────────────────────────────────────────────

program
  .command('deps')
  .description('Package.json hygiene: declared-unused / missing / devOnly deps + low-value barrels')
  .argument('[snapshot]', 'Path to snapshot JSON file (default: latest)')
  .option('-c, --config <path>', 'Path to codegraph config file')
  .option('--json', 'Output as JSON')
  .option('--only <kind>', 'Filter issues by kind: declared-unused | missing | devOnly')
  .action(async (snapshotPath, opts) => {
    await runDepsCommand(snapshotPath, opts)
  })

// ─── diff ─────────────────────────────────────────────────────────────────

program
  .command('diff')
  .description('Compare two snapshots or git refs')
  .argument('[before]', 'Snapshot path or git ref (e.g., HEAD~1, abc123)')
  .argument('[after]', 'Snapshot path or git ref (default: current working tree)')
  .option('-c, --config <path>', 'Path to codegraph config file')
  .option('--json', 'Output diff as JSON')
  .option('--viewer', 'Generate diff.json and launch web viewer')
  .option('--report', 'Extended textual report with file lists')
  .option('--structural', 'Compute the phase-1 structural diff (cycles, FSM, flows, …)')
  .option('--md', 'Render the structural diff as markdown (implies --structural)')
  .action(runDiffCommand)

// ─── check ────────────────────────────────────────────────────────────────

program
  .command('check')
  .description('Run structural CI rules comparing current tree vs a reference')
  .option('-c, --config <path>', 'Path to codegraph config file')
  .option('-r, --root <path>', 'Project root directory (overrides config rootDir)')
  .option(
    '--against <ref>',
    'Git ref or snapshot.json path to compare against (default: HEAD)',
    'HEAD',
  )
  .option('--json', 'Output violations as JSON')
  .option('--list-rules', 'List the available rules and their default severity')
  .action(async (opts) => {
    await runCheckCommand(opts)
  })

// ─── facts ────────────────────────────────────────────────────────────────

program
  .command('facts')
  .description('Export the snapshot as Soufflé Datalog .facts files (TSV) + schema.dl')
  .argument('[snapshot]', 'Path to snapshot JSON file (default: latest)')
  .option('-c, --config <path>', 'Path to codegraph config file')
  .option('-o, --output <dir>', 'Output directory (default: <snapshotDir>/facts)')
  .option(
    '--regen',
    'Re-analyze the project in facts-only mode FIRST, then export. Skips heavy ' +
      'extractors (unused-exports, typed-calls, data-flows, taint, …) — about 3x ' +
      'faster than a full `codegraph analyze`. Use at pre-commit to refresh facts ' +
      'against the staged tree without paying the full pipeline cost.',
  )
  .action(async (snapshotPath, opts) => {
    const config = await loadConfig(opts)
    let snapshot: GraphSnapshot
    if (opts.regen) {
      console.log(chalk.dim('  Re-analyzing in facts-only mode...'))
      const t0 = performance.now()
      const result = await analyze(config, { factsOnly: true })
      snapshot = result.snapshot
      const elapsed = (performance.now() - t0) / 1000
      console.log(chalk.dim(`  Analyze done in ${elapsed.toFixed(2)}s`))
    } else {
      snapshot = await loadSnapshot(snapshotPath, opts)
    }

    const outDir: string = opts.output
      ? path.resolve(opts.output)
      : path.join(config.snapshotDir, 'facts')

    const result = await exportFacts(snapshot, { outDir })

    console.log(chalk.bold('\n  CodeGraph Facts (Datalog export)\n'))
    console.log(`  ${chalk.dim('out')}    ${result.outDir}`)
    console.log(`  ${chalk.dim('schema')} ${path.relative(process.cwd(), result.schemaFile)}`)
    console.log()
    const totalTuples = result.relations.reduce((s, r) => s + r.tuples, 0)
    for (const r of result.relations) {
      const tuples = r.tuples === 0
        ? chalk.dim('0')
        : r.tuples > 1000
          ? chalk.yellow(String(r.tuples))
          : chalk.green(String(r.tuples))
      console.log(`  ${r.name.padEnd(18)} ${tuples.padStart(7)} tuples`)
    }
    console.log()
    console.log(chalk.dim(`  Total: ${totalTuples} tuples across ${result.relations.length} relations`))
    console.log()
  })

// ─── datalog-check ────────────────────────────────────────────────────────
// Phase 4 Tier 8 : exécute toutes les rules .dl du projet contre les facts
// live (régénérés par `codegraph watch`). Mode --diff compare avec une
// baseline cachée pour n'afficher QUE les nouvelles violations introduites
// depuis la dernière baseline (typiquement le dernier commit).
//
// Utilisé par le hook PostToolUse pour gater chaque Edit/Write avec
// l'ensemble des invariants Datalog (mono + composites multi-relation),
// pas seulement au pre-commit.

program
  .command('datalog-check')
  .description('Run all .dl rules against current facts. --diff: only NEW violations vs cached baseline.')
  .option('--rules-dir <path>', 'Directory containing .dl rule files (default: <root>/sentinel-core/invariants if exists, else <root>/invariants)')
  .option('--facts-dir <path>', 'Directory containing .facts files (default: <root>/.codegraph/facts)')
  .option('--baseline <path>', 'Baseline JSON to diff against (default: <root>/.codegraph/violations-baseline.json)')
  .option('--diff', 'Show only violations NOT in baseline (i.e. introduced since baseline)', false)
  .option('--update-baseline', 'After running, write current violations to baseline file (typically post-commit)', false)
  .option('--json', 'Emit JSON instead of text (for hook consumption)', false)
  .option('--format <type>', 'Alternative output format. `sarif` emits SARIF 2.1.0 (consumable by GitHub Code Scanning, VS Code SARIF Viewer, etc.)')
  .option('--sarif', 'Alias for `--format sarif` — emits SARIF 2.1.0', false)
  .option('--timeout <ms>', 'Hard timeout in ms (default 5000). Skip if exceeded.', '5000')
  .action(runDatalogCheckCommand)

// ─── cross-check ──────────────────────────────────────────────────────────
// ADR-026 phase D : composite runner statique × dynamique. Charge facts
// statique (.codegraph/facts/) + facts dynamique (.codegraph/facts-runtime/)
// + une dir de rules .dl, évalue tout via le composite runner avec cache
// module-level. Diffère de `datalog-check` qui ne charge que le statique.
//
// Workflow typique :
//   1. codegraph analyze              → .codegraph/facts/
//   2. liby-runtime-graph run         → .codegraph/facts-runtime/
//   3. codegraph cross-check rules-dir → DEAD_HANDLER, DEAD_ROUTE, etc.

program
  .command('cross-check')
  .description('Statique × dynamique composite check : merge .codegraph/facts/ + facts-runtime/ + rules .dl')
  .option('--rules-dir <path>', 'Directory containing composite cross-cut .dl rules (default: <root>/.codegraph/rules-cross-cut)')
  .option('--facts-dir <path>', 'Directory containing static .facts (default: <root>/.codegraph/facts)')
  .option('--facts-runtime-dir <path>', 'Directory containing runtime .facts (default: <root>/.codegraph/facts-runtime)')
  .option('--json', 'Emit JSON instead of text', false)
  .option('--verbose', 'Print stats cache hit + tuples breakdown', false)
  .action(runCrossCheckCommand)

// ─── memory ───────────────────────────────────────────────────────────────

const memoryCmd = program
  .command('memory')
  .description('Inter-session memory: false-positives, decisions, incident fingerprints')

memoryCmd
  .command('list')
  .description('List memory entries for the current project')
  .option('-r, --root <path>', 'Project root (default: cwd)')
  .option('-k, --kind <kind>', 'Filter by kind (false-positive | decision | incident)')
  .option('-f, --file <file>', 'Filter by scope.file')
  .option('--include-obsolete', 'Include obsoleted entries')
  .option('--json', 'Output raw JSON instead of formatted text')
  .action(async (opts) => {
    const root = opts.root ?? process.cwd()
    const entries = await recall(root, {
      kind: opts.kind,
      file: opts.file,
      includeObsolete: opts.includeObsolete,
    })
    if (opts.json) {
      console.log(JSON.stringify(entries, null, 2))
      return
    }
    console.log(chalk.bold(`\n  Memory — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`))
    console.log(chalk.dim(`  Store: ${memoryPathFor(root)}\n`))
    if (entries.length === 0) {
      console.log(chalk.dim('  (empty)\n'))
      return
    }
    for (const e of entries) {
      const obsoleteTag = e.obsoleteAt ? chalk.yellow(' [OBSOLETE]') : ''
      console.log(`  ${chalk.cyan('[' + e.kind + ']')} ${chalk.bold(e.fingerprint)}${obsoleteTag}`)
      console.log(`    ${e.reason}`)
      if (e.scope) {
        const bits: string[] = []
        if (e.scope.file) bits.push(`file=${e.scope.file}`)
        if (e.scope.detector) bits.push(`detector=${e.scope.detector}`)
        if (e.scope.tags && e.scope.tags.length > 0) bits.push(`tags=${e.scope.tags.join(',')}`)
        if (bits.length > 0) console.log(chalk.dim(`    scope: ${bits.join(', ')}`))
      }
      console.log(chalk.dim(`    id: ${e.id}  ·  added: ${e.addedAt.slice(0, 10)}`))
      console.log()
    }
  })

memoryCmd
  .command('mark <kind> <fingerprint> <reason>')
  .description('Add (or update) a memory entry')
  .option('-r, --root <path>', 'Project root (default: cwd)')
  .option('--scope-file <file>', 'Scope: relative file path')
  .option('--scope-detector <detector>', 'Scope: detector name')
  .option('--scope-tags <tags>', 'Scope: comma-separated tags')
  .action(async (kind, fingerprint, reason, opts) => {
    if (!['false-positive', 'decision', 'incident'].includes(kind)) {
      console.error(chalk.red(`Invalid kind: ${kind}. Must be one of: false-positive, decision, incident`))
      process.exit(1)
    }
    const root = opts.root ?? process.cwd()
    const scope = (opts.scopeFile || opts.scopeDetector || opts.scopeTags)
      ? {
          file: opts.scopeFile,
          detector: opts.scopeDetector,
          tags: opts.scopeTags ? String(opts.scopeTags).split(',') : undefined,
        }
      : undefined
    const e = await addEntry(root, { kind, fingerprint, reason, scope })
    console.log(chalk.green('  ✓ saved'))
    console.log(chalk.dim(`    id: ${e.id}  ·  ${memoryPathFor(root)}`))
  })

memoryCmd
  .command('obsolete <id>')
  .description('Mark an entry as obsolete (keeps audit trail)')
  .option('-r, --root <path>', 'Project root (default: cwd)')
  .action(async (id, opts) => {
    const root = opts.root ?? process.cwd()
    const ok = await markObsolete(root, id)
    if (!ok) {
      console.error(chalk.red(`No entry found with id: ${id}`))
      process.exit(1)
    }
    console.log(chalk.yellow('  ✓ obsoleted'))
  })

memoryCmd
  .command('delete <id>')
  .description('Hard-delete an entry (no audit trail)')
  .option('-r, --root <path>', 'Project root (default: cwd)')
  .action(async (id, opts) => {
    const root = opts.root ?? process.cwd()
    const ok = await deleteEntry(root, id)
    if (!ok) {
      console.error(chalk.red(`No entry found with id: ${id}`))
      process.exit(1)
    }
    console.log(chalk.green('  ✓ deleted'))
  })

memoryCmd
  .command('prune')
  .description('Hard-delete all obsolete entries (keeps active ones)')
  .option('-r, --root <path>', 'Project root (default: cwd)')
  .action(async (opts) => {
    const root = opts.root ?? process.cwd()
    const store = await loadMemoryRaw(root)
    const obsoleteIds = store.entries.filter((e) => e.obsoleteAt !== null).map((e) => e.id)
    if (obsoleteIds.length === 0) {
      console.log(chalk.dim('  No obsolete entries to prune.'))
      return
    }
    // Delete N obsolete entries en parallèle (mutations file-store indépendantes).
    await Promise.all(obsoleteIds.map((id) => deleteEntry(root, id)))
    console.log(chalk.green(`  ✓ pruned ${obsoleteIds.length} obsolete entr${obsoleteIds.length === 1 ? 'y' : 'ies'}`))
  })

memoryCmd
  .command('export')
  .description('Dump the raw memory store as JSON (for backup / inspection)')
  .option('-r, --root <path>', 'Project root (default: cwd)')
  .action(async (opts) => {
    const root = opts.root ?? process.cwd()
    const store = await loadMemoryRaw(root)
    console.log(JSON.stringify(store, null, 2))
  })

memoryCmd
  .command('where')
  .description('Print the memory store path for the current project')
  .option('-r, --root <path>', 'Project root (default: cwd)')
  .action((opts) => runMemoryWhere(opts))

// ─── serve ────────────────────────────────────────────────────────────────

program
  .command('serve')
  .description('Start local server for the web viewer with live API')
  .option('-p, --port <port>', 'Port number', '3333')
  .option('-c, --config <path>', 'Path to codegraph config file')
  .option('-s, --snapshot <path>', 'Path to snapshot JSON to preload')
  .option('-d, --diff <path>', 'Path to diff JSON to preload for overlay')
  .action(async (opts) => {
    await runServeCommand(opts)
  })

// ─── Run ──────────────────────────────────────────────────────────────────

// Guard auto-run : ne parse les argv QUE si ce fichier est invoqué comme
// entry point. Permet aux tests d'importer le module + inspecter les
// commands enregistrées sans déclencher l'exécution CLI.
//
// Comparaison via realpath car npm/pnpm bin scripts utilisent des
// symlinks (~/.npm/_npx/.../node_modules/.bin/codegraph → dist/cli/index.js)
// qui ne matchent pas une simple égalité d'URL.
async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false
  const { fileURLToPath } = await import('node:url')
  const { realpathSync } = await import('node:fs')
  try {
    const here = realpathSync(fileURLToPath(import.meta.url))
    const argv1 = realpathSync(process.argv[1])
    return here === argv1
  } catch {
    return false
  }
}

if (await isMainModule()) {
  program.parse()
}

export { program }
