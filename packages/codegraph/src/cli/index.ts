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
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
// Extracted commands (P2a/P2b god-file split — commands moved to cli/commands/)
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
import { runRankCommand } from './commands/rank.js'
import { runSynopsisCommand } from './commands/synopsis.js'
import { runDetectorsCommand } from './commands/detectors.js'
import { runWatchCommand } from './commands/watch.js'
import { runMapCommand } from './commands/map.js'
import { runOrphansCommand } from './commands/orphans.js'
import { runTaintCommand } from './commands/taint.js'
import { runDsmCommand } from './commands/dsm.js'
import { runFactsCommand } from './commands/facts.js'
import { runReachCommand } from './commands/reach.js'
import {
  runMemoryList, runMemoryMark, runMemoryObsolete,
  runMemoryDelete, runMemoryPrune, runMemoryExport,
} from './commands/memory.js'

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
  .action(runDetectorsCommand)

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
  .action(runAnalyzeCommand)

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
  .action(runWatchCommand)

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
  .action(runMapCommand)

// ─── synopsis ─────────────────────────────────────────────────────────────

program
  .command('synopsis')
  .description('Generate mental map — static C4 levels (default) or focused dynamic (--focus)')
  .argument('[snapshot]', 'Path to snapshot JSON file (default: latest)')
  .option('-c, --config <path>', 'Path to codegraph config file')
  .option('-l, --level <n>', 'Static mode: level 1 (context), 2 (containers), 3 (components)', '1')
  .option('--container <id>', 'Container id for Level 3 (e.g. sentinel-core)')
  .option('--format <fmt>', 'Output format: md | json', 'md')
  .option('-f, --focus <file...>', 'Focused mode: render PageRank-ranked synopsis around these files')
  .option('--tokens <n>', 'Token budget for focused mode (default 1500)', '1500')
  .option('--recent', 'Boost recently-modified files (focused mode)')
  .action(async (snapshotPath, opts) => {
    await runSynopsisCommand(snapshotPath, opts)
  })

// ─── orphans ──────────────────────────────────────────────────────────────

program
  .command('orphans')
  .description('List orphan nodes from a snapshot')
  .argument('[snapshot]', 'Path to snapshot JSON file')
  .option('-c, --config <path>', 'Path to codegraph config file')
  .option('--json', 'Output as JSON')
  .action(runOrphansCommand)

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

// ─── rank ─────────────────────────────────────────────────────────────────

program
  .command('rank')
  .description('Personalized PageRank — top fichiers pertinents pour un focus donné (Aider-style context selection)')
  .option('-c, --config <path>', 'Path to codegraph config file')
  .option('-f, --focus <file...>', 'Files in current focus (repeatable: -f a.ts -f b.ts)')
  .option('--top <n>', 'Number of files to show (default 30)', '30')
  .option('--recent', 'Boost files modified in the last 3 weeks (git log)')
  .option('--json', 'Output as JSON for programmatic consumption')
  .action(async (opts) => {
    await runRankCommand(opts)
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
  .action(runReachCommand)

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
  .action(runTaintCommand)

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
  .action(runDsmCommand)

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
  .action(runFactsCommand)

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
  .action(runMemoryList)

memoryCmd
  .command('mark <kind> <fingerprint> <reason>')
  .description('Add (or update) a memory entry')
  .option('-r, --root <path>', 'Project root (default: cwd)')
  .option('--scope-file <file>', 'Scope: relative file path')
  .option('--scope-detector <detector>', 'Scope: detector name')
  .option('--scope-tags <tags>', 'Scope: comma-separated tags')
  .action(runMemoryMark)

memoryCmd
  .command('obsolete <id>')
  .description('Mark an entry as obsolete (keeps audit trail)')
  .option('-r, --root <path>', 'Project root (default: cwd)')
  .action(runMemoryObsolete)

memoryCmd
  .command('delete <id>')
  .description('Hard-delete an entry (no audit trail)')
  .option('-r, --root <path>', 'Project root (default: cwd)')
  .action(runMemoryDelete)

memoryCmd
  .command('prune')
  .description('Hard-delete all obsolete entries (keeps active ones)')
  .option('-r, --root <path>', 'Project root (default: cwd)')
  .action(runMemoryPrune)

memoryCmd
  .command('export')
  .description('Dump the raw memory store as JSON (for backup / inspection)')
  .option('-r, --root <path>', 'Project root (default: cwd)')
  .action(runMemoryExport)

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
