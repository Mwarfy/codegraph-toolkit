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
import * as path from 'node:path'
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

const program = new Command()

program
  .name('codegraph')
  .description('Visual dependency graph for AI-supervised codebases')
  .version('0.1.0')

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

interface ArchRule {
  name: string
  description?: string
  from: string
  /** Single-hop forbidden target (existing sentinel-core behavior). */
  disallow?: string
  /** Transitive forbidden target (phase 3.7 #1). */
  disallowReachable?: string
}

program
  .command('arch-check')
  .description('Validate architecture rules (arch-rules.json) against the current snapshot')
  .option('-c, --config <path>', 'Path to codegraph config file')
  .option('-r, --rules <path>', 'Path to arch-rules.json (default: <rootDir>/arch-rules.json or <rootDir>/codegraph/arch-rules.json)')
  .option('--json', 'Output violations as JSON')
  .action(async (opts) => {
    const config = await loadConfig(opts)
    const snapshot = await loadSnapshot(undefined, opts)

    // Resolve rules file path.
    let rulesPath = opts.rules as string | undefined
    if (!rulesPath) {
      const candidates = [
        path.join(config.rootDir, 'arch-rules.json'),
        path.join(config.rootDir, 'codegraph', 'arch-rules.json'),
      ]
      for (const p of candidates) {
        // await-ok: probe avec break sur première match, séquentiel requis
        try { await fs.access(p); rulesPath = p; break } catch { /* probe: try next */ }
      }
    }
    if (!rulesPath) {
      console.error(chalk.red('  No arch-rules.json found. Pass --rules or place one at the project root.'))
      process.exit(1)
    }

    const raw = JSON.parse(await fs.readFile(rulesPath, 'utf-8'))
    const rules: ArchRule[] = Array.isArray(raw.rules) ? raw.rules : []

    const files = snapshot.nodes.filter((n) => n.type === 'file').map((n) => n.id)
    const fileSet = new Set(files)

    interface Violation {
      rule: string
      description?: string
      kind: 'direct' | 'transitive'
      from: string
      to: string
      path?: string[]
    }
    const violations: Violation[] = []

    for (const r of rules) {
      if (!r.name || !r.from) continue
      const fromRe = globToRegex(r.from)
      const sources = new Set(files.filter((f) => fromRe.test(f)))
      if (sources.size === 0) continue

      // Direct `disallow` — reuse existing single-hop semantics.
      if (r.disallow) {
        const toRe = globToRegex(r.disallow)
        for (const e of snapshot.edges) {
          if (e.type !== 'import') continue
          if (!fileSet.has(e.from) || !fileSet.has(e.to)) continue
          if (fromRe.test(e.from) && toRe.test(e.to)) {
            violations.push({
              rule: r.name,
              ...(r.description ? { description: r.description } : {}),
              kind: 'direct',
              from: e.from,
              to: e.to,
            })
          }
        }
      }

      // Transitive `disallowReachable` — new.
      if (r.disallowReachable) {
        const toRe = globToRegex(r.disallowReachable)
        const targets = new Set(files.filter((f) => toRe.test(f)))
        if (targets.size === 0) continue
        const paths = findReachablePaths(sources, targets, snapshot.edges)
        for (const p of paths) {
          violations.push({
            rule: r.name,
            ...(r.description ? { description: r.description } : {}),
            kind: 'transitive',
            from: p.from,
            to: p.to,
            path: p.path,
          })
        }
      }
    }

    if (opts.json) {
      console.log(JSON.stringify({ rulesFile: rulesPath, rulesCount: rules.length, violations }, null, 2))
      process.exit(violations.length > 0 ? 1 : 0)
    }

    console.log(chalk.bold('\n  CodeGraph Arch Check\n'))
    console.log(`  ${chalk.dim('rules file')} ${rulesPath}`)
    console.log(`  ${chalk.dim('rules')}      ${rules.length}`)
    console.log()

    if (violations.length === 0) {
      console.log(chalk.green('  ✓ No violations.\n'))
      process.exit(0)
    }

    // Group by rule for readable output.
    const byRule = new Map<string, Violation[]>()
    for (const v of violations) {
      const list = byRule.get(v.rule) ?? []
      list.push(v)
      byRule.set(v.rule, list)
    }
    for (const [name, vs] of byRule) {
      console.log(chalk.red(`  ✗ ${name}`) + chalk.dim(`  (${vs.length})`))
      const direct = vs.filter((v) => v.kind === 'direct')
      const transitive = vs.filter((v) => v.kind === 'transitive')
      for (const v of direct.slice(0, 10)) {
        console.log(`      direct     ${v.from} → ${v.to}`)
      }
      if (direct.length > 10) console.log(chalk.dim(`      … +${direct.length - 10} more direct`))
      for (const v of transitive.slice(0, 10)) {
        console.log(`      transitive ${v.path!.join(' → ')}`)
      }
      if (transitive.length > 10) console.log(chalk.dim(`      … +${transitive.length - 10} more transitive`))
      console.log()
    }

    console.log(chalk.red(`  ${violations.length} violation(s)\n`))
    process.exit(1)
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
    const snapshot = await loadSnapshot(undefined, opts)

    // Si aucun fichier passé, fallback git diff --name-only HEAD
    let inputs = files
    if (inputs.length === 0) {
      try {
        const { execSync } = await import('node:child_process')
        const out = execSync('git diff --name-only HEAD', { encoding: 'utf-8' }).trim()
        inputs = out.length > 0 ? out.split('\n') : []
      } catch {
        console.error(chalk.yellow('  No files passed and `git diff --name-only HEAD` failed.'))
        process.exitCode = 1
        return
      }
    }
    if (inputs.length === 0) {
      console.error(chalk.dim('  No modified files. Nothing affected.'))
      return
    }

    const maxDepth = parseInt(opts.maxDepth, 10) || Infinity
    const includeIndirect = !!opts.includeIndirect
    const result = computeAffectedFromCli(snapshot, inputs, { includeIndirect, maxDepth })

    // Optionnel : scan des tests à la volée si --tests-glob fourni (utile
    // quand la config codegraph exclut les tests du snapshot, ex Sentinel).
    if (opts.testsGlob) {
      const extraTests = await scanTestsImportingAffected(
        opts.testsGlob,
        new Set(result.affectedFiles),
      )
      // Add extra tests to affectedTests + affectedFiles (déduplication via Set)
      const allTests = new Set([...result.affectedTests, ...extraTests])
      result.affectedTests = [...allTests].sort()
      const allFiles = new Set([...result.affectedFiles, ...extraTests])
      result.affectedFiles = [...allFiles].sort()
    }

    const out = opts.testsOnly ? result.affectedTests : result.affectedFiles

    if (opts.json) {
      console.log(JSON.stringify({
        inputs,
        affectedFiles: result.affectedFiles,
        affectedTests: result.affectedTests,
        unknownInputs: result.unknownInputs,
        maxDepthReached: result.maxDepthReached,
      }, null, 2))
      return
    }

    if (opts.testsOnly) {
      // Mode pipe-friendly : un fichier par ligne, sans cosmétique
      for (const f of out) console.log(f)
      return
    }

    console.log(chalk.bold(`\n  Affected from ${inputs.length} input(s)\n`))
    console.log(`  ${result.affectedFiles.length} file(s) impacted (${result.affectedTests.length} test(s))`)
    if (result.unknownInputs.length > 0) {
      console.log(chalk.yellow(`  ${result.unknownInputs.length} unknown input(s) (not in graph):`))
      for (const u of result.unknownInputs) console.log(`    - ${u}`)
    }
    console.log()
    console.log(chalk.bold('  Tests to run:'))
    for (const t of result.affectedTests) console.log(`    ${t}`)
    if (result.affectedTests.length === 0) {
      console.log(chalk.dim('    (none)'))
    }
    console.log()
  })

/**
 * Scan tests à la volée : pour chaque fichier matchant `testsGlob`, lit son
 * source, extrait les imports relatifs, résout vers un chemin, et marque le
 * test si l'un de ses imports résolus est dans `affectedFiles`.
 *
 * Nécessaire quand la config codegraph exclut les tests du snapshot.
 * Approche regex-based (rapide, ~10ms/fichier sur Sentinel) — pas de
 * ts-morph load pour ça.
 */
const TEST_DISCOVER_SKIP_DIRS = new Set(['node_modules', 'dist', '.git'])
const IMPORT_PATH_RE = /^\s*(?:import|export)\s+(?:[^'"]+from\s+)?['"]([^'"]+)['"]/gm

/**
 * Walk recursive avec minimatch glob filter. Skip dirs blacklist
 * (node_modules, dist, .git). Errors silencieuses (permissions, race).
 */
async function discoverTestCandidates(
  testsGlob: string,
  cwd: string,
  fastGlob: typeof import('node:fs/promises'),
  pathMod: typeof import('node:path'),
  minimatch: any,
): Promise<string[]> {
  const candidates: string[] = []
  const walk = async (dir: string): Promise<void> => {
    try {
      const entries = await fastGlob.readdir(dir, { withFileTypes: true })
      for (const e of entries) {
        const full = pathMod.join(dir, e.name)
        if (e.isDirectory()) {
          if (TEST_DISCOVER_SKIP_DIRS.has(e.name)) continue
          // await-ok: walk recursif tests-discovery — sequentiel acceptable, perf non-critique CLI affected.
          await walk(full)
        } else {
          const rel = pathMod.relative(cwd, full).replace(/\\/g, '/')
          if (minimatch(rel, testsGlob)) candidates.push(rel)
        }
      }
    } catch { /* dir unreadable (permissions, race) — skip ce sous-arbre */ }
  }
  await walk(cwd)
  return candidates
}

function extractImportPaths(content: string): Set<string> {
  const out = new Set<string>()
  IMPORT_PATH_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = IMPORT_PATH_RE.exec(content)) !== null) {
    out.add(m[1])
  }
  return out
}

/**
 * True si l'1 des candidats `<rel>.ts | <rel>.tsx | <rel>/index.ts`
 * est dans le set affected. Strip `.js` extension (ESM-style imports
 * d'un `.ts`).
 */
function importHitsAffectedFile(
  importPath: string,
  testDir: string,
  affectedFiles: Set<string>,
  pathMod: typeof import('node:path'),
): boolean {
  if (!importPath.startsWith('.')) return false
  const stripped = importPath.replace(/\.js$/, '')
  const resolvedNoExt = pathMod.normalize(pathMod.join(testDir, stripped)).replace(/\\/g, '/')
  const candidates = [
    resolvedNoExt + '.ts',
    resolvedNoExt + '.tsx',
    resolvedNoExt + '/index.ts',
  ]
  return candidates.some((c) => affectedFiles.has(c))
}

async function scanTestsImportingAffected(
  testsGlob: string,
  affectedFiles: Set<string>,
): Promise<string[]> {
  const fastGlob = await import('node:fs/promises')
  const pathMod = await import('node:path')
  const minimatchMod = await import('minimatch')
  const minimatch = (minimatchMod as any).minimatch ?? (minimatchMod as any).default
  const cwd = process.cwd()

  const candidates = await discoverTestCandidates(testsGlob, cwd, fastGlob, pathMod, minimatch)

  // Lit N test files en parallele (I/O independantes), parse sequentiel.
  const testContents = await Promise.all(
    candidates.map(async (test) => {
      try {
        return { test, content: await fastGlob.readFile(pathMod.join(cwd, test), 'utf-8') }
      } catch { return null }
    }),
  )

  const matchingTests: string[] = []
  for (const entry of testContents) {
    if (!entry) continue
    const { test, content } = entry
    const importPaths = extractImportPaths(content)
    const testDir = pathMod.dirname(test)
    for (const imp of importPaths) {
      if (importHitsAffectedFile(imp, testDir, affectedFiles, pathMod)) {
        matchingTests.push(test)
        break
      }
    }
  }
  return [...new Set(matchingTests)].sort()
}

type CliEdge = { from: string; to: string; type: string }

const CLI_TEST_FILE_RE = /(\.test\.tsx?|\.spec\.tsx?|^tests?\/|\/tests?\/)/

function buildCliImporterIndex(edges: CliEdge[], includeIndirect: boolean): Map<string, Set<string>> {
  const importerOf = new Map<string, Set<string>>()
  for (const e of edges) {
    const isPrimary = e.type === 'import'
    const isIndirect = includeIndirect && (e.type === 'event' || e.type === 'queue' || e.type === 'db-table')
    if (!isPrimary && !isIndirect) continue
    if (!importerOf.has(e.to)) importerOf.set(e.to, new Set())
    importerOf.get(e.to)!.add(e.from)
  }
  return importerOf
}

function bfsCliAffected(
  inputs: string[],
  nodeIds: Set<string>,
  importerOf: Map<string, Set<string>>,
  maxDepth: number,
): { affected: Set<string>; unknownInputs: string[]; maxDepthReached: number } {
  const affected = new Set<string>()
  const unknownInputs: string[] = []
  const queue: Array<{ file: string; depth: number }> = []
  for (const input of inputs) {
    const norm = input.replace(/\\/g, '/')
    if (!nodeIds.has(norm)) { unknownInputs.push(norm); continue }
    affected.add(norm)
    queue.push({ file: norm, depth: 0 })
  }
  let maxDepthReached = 0
  while (queue.length > 0) {
    const { file, depth } = queue.shift()!
    if (depth >= maxDepth) continue
    const importers = importerOf.get(file)
    if (!importers) continue
    for (const importer of importers) {
      if (affected.has(importer)) continue
      affected.add(importer)
      maxDepthReached = Math.max(maxDepthReached, depth + 1)
      if (depth + 1 < maxDepth) queue.push({ file: importer, depth: depth + 1 })
    }
  }
  return { affected, unknownInputs, maxDepthReached }
}

function computeAffectedFromCli(
  snapshot: any,
  files: string[],
  options: { includeIndirect?: boolean; maxDepth?: number },
): { affectedFiles: string[]; affectedTests: string[]; maxDepthReached: number; unknownInputs: string[] } {
  const includeIndirect = options.includeIndirect ?? false
  const maxDepth = options.maxDepth ?? Infinity
  const edges: CliEdge[] = snapshot.edges ?? []
  const nodeIds = new Set<string>((snapshot.nodes ?? []).map((n: any) => n.id))

  const importerOf = buildCliImporterIndex(edges, includeIndirect)
  const { affected, unknownInputs, maxDepthReached } = bfsCliAffected(files, nodeIds, importerOf, maxDepth)

  const affectedFiles = [...affected].sort()
  const affectedTests = affectedFiles.filter((f) => CLI_TEST_FILE_RE.test(f))
  return { affectedFiles, affectedTests, maxDepthReached, unknownInputs }
}

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
    const snapshot = await loadSnapshot(snapshotPath, opts)
    const filesWithExports = snapshot.nodes.filter((n: any) => n.exports && n.exports.length > 0)

    if (opts.file) {
      // Single file mode
      const q = opts.file.toLowerCase()
      const node = filesWithExports.find((n: any) =>
        n.id.toLowerCase() === q || n.id.toLowerCase().endsWith(q) || n.id.toLowerCase().includes(q)
      )
      if (!node) {
        console.log(chalk.red(`  No file matching "${opts.file}" with export data.\n`))
        return
      }

      const nodeExports = node.exports || []
      const filteredExports = opts.all
        ? nodeExports
        : nodeExports.filter((e: any) => e.usageCount === 0 && !e.reExport)

      if (opts.json) {
        console.log(JSON.stringify({ file: node.id, exports: filteredExports }, null, 2))
        return
      }

      const unused = nodeExports.filter((e: any) => e.usageCount === 0 && !e.reExport).length
      console.log(chalk.bold(`\n  ${node.id}`))
      console.log(`  ${unused}/${nodeExports.length} unused exports\n`)

      const confIcon: Record<string, string> = {
        'safe-to-remove': chalk.red('×'),
        'test-only': chalk.blue('⊤'),
        'possibly-dynamic': chalk.yellow('?'),
        'local-only': chalk.magenta('◐'),
        'used': chalk.green('✓'),
      }
      const confTag: Record<string, string> = {
        'safe-to-remove': chalk.red('DEAD'),
        'test-only': chalk.blue('TEST'),
        'possibly-dynamic': chalk.yellow('DYN?'),
        'local-only': chalk.magenta('LOCAL'),
        'used': chalk.green('USED'),
      }

      for (const e of filteredExports) {
        const c = (e as any).confidence || (e.usageCount > 0 ? 'used' : 'safe-to-remove')
        const icon = confIcon[c] || chalk.dim('?')
        const tag = (confTag[c] || '').padEnd(16)
        const name = c === 'used' ? chalk.dim(e.name) : chalk.yellow(e.name)
        const kind = chalk.dim(`[${e.kind}]`)
        const usage = e.usageCount === 0 ? chalk.red('×0') : chalk.dim(`×${e.usageCount}`)
        console.log(`    ${icon} ${tag} ${kind.padEnd(22)} ${name.padEnd(30)} ${usage}  L${e.line}`)
        if ((e as any).reason) {
          console.log(chalk.dim(`                 ${(e as any).reason}`))
        }
      }
      console.log()
      return
    }

    // Summary mode
    const totalExports = filesWithExports.reduce((s: number, n: any) => s + n.exports.length, 0)
    const totalUnused = filesWithExports.reduce((s: number, n: any) =>
      s + n.exports.filter((e: any) => e.usageCount === 0 && !e.reExport).length, 0)

    if (opts.json) {
      const ranked = filesWithExports
        .map((n: any) => ({
          file: n.id,
          totalExports: n.exports.length,
          unusedCount: n.exports.filter((e: any) => e.usageCount === 0 && !e.reExport).length,
          unusedSymbols: n.exports.filter((e: any) => e.usageCount === 0 && !e.reExport).map((e: any) => e.name),
        }))
        .filter((r: any) => r.unusedCount > 0)
        .sort((a: any, b: any) => b.unusedCount - a.unusedCount)
      console.log(JSON.stringify({ totalExports, totalUnused, files: ranked }, null, 2))
      return
    }

    // Confidence totals
    const conf = { safe: 0, test: 0, dynamic: 0, local: 0 }
    for (const n of filesWithExports) {
      for (const e of (n as any).exports) {
        if (e.confidence === 'safe-to-remove') conf.safe++
        else if (e.confidence === 'test-only') conf.test++
        else if (e.confidence === 'possibly-dynamic') conf.dynamic++
        else if (e.confidence === 'local-only') conf.local++
      }
    }

    console.log(chalk.bold('\n  Dead Exports Report\n'))
    console.log(`  Total exports:  ${totalExports} across ${filesWithExports.length} files`)
    console.log(`  ${chalk.red(String(conf.safe))} safe to remove · ${chalk.magenta(String(conf.local))} local-only · ${chalk.blue(String(conf.test))} test-only · ${chalk.yellow(String(conf.dynamic))} possibly dynamic`)
    console.log()

    const ranked = filesWithExports
      .map((n: any) => ({
        file: n.id, exports: n.exports,
        safe: n.exports.filter((e: any) => e.confidence === 'safe-to-remove').length,
        local: n.exports.filter((e: any) => e.confidence === 'local-only').length,
        test: n.exports.filter((e: any) => e.confidence === 'test-only').length,
        dynamic: n.exports.filter((e: any) => e.confidence === 'possibly-dynamic').length,
        unused: n.exports.filter((e: any) => e.usageCount === 0 && !e.reExport).length,
        total: n.exports.length,
      }))
      .filter((r: any) => r.unused > 0)
      .sort((a: any, b: any) => b.safe - a.safe || b.unused - a.unused)

    for (const r of ranked) {
      const tags = [];
      if (r.safe > 0) tags.push(chalk.red(`${r.safe} dead`))
      if (r.local > 0) tags.push(chalk.magenta(`${r.local} local`))
      if (r.test > 0) tags.push(chalk.blue(`${r.test} test`))
      if (r.dynamic > 0) tags.push(chalk.yellow(`${r.dynamic} dyn?`))
      console.log(`  ${String(r.unused).padStart(3)}/${r.total.toString().padStart(3)}  ${r.file}`)
      console.log(`         ${tags.join(' · ')}`)
    }
    console.log()
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
    const snapshot = await loadSnapshot(snapshotPath, opts)
    const issues = snapshot.packageDeps ?? []
    const barrels = snapshot.barrels ?? []

    const filtered = opts.only
      ? issues.filter((i) => i.kind === opts.only)
      : issues
    const lowValueBarrels = barrels.filter((b) => b.lowValue)

    if (opts.json) {
      console.log(JSON.stringify({
        issues: filtered,
        barrels: { total: barrels.length, lowValue: lowValueBarrels },
      }, null, 2))
      process.exit(filtered.some((i) => i.kind === 'missing') ? 1 : 0)
    }

    console.log(chalk.bold('\n  Package Deps Hygiene\n'))

    if (issues.length === 0) {
      console.log(chalk.green('  ✓ No deps issues.\n'))
    } else {
      // Group by packageJson
      const byManifest = new Map<string, typeof issues>()
      for (const i of filtered) {
        const list = byManifest.get(i.packageJson) ?? []
        list.push(i)
        byManifest.set(i.packageJson, list)
      }

      const counts = { 'declared-unused': 0, 'declared-runtime-asset': 0, missing: 0, devOnly: 0 }
      for (const i of filtered) counts[i.kind]++
      console.log(`  ${chalk.red(String(counts.missing))} missing · ${chalk.yellow(String(counts['declared-unused']))} declared-unused · ${chalk.magenta(String(counts['declared-runtime-asset']))} runtime-asset · ${chalk.blue(String(counts.devOnly))} devOnly`)
      console.log()

      for (const [manifest, list] of [...byManifest].sort()) {
        console.log(chalk.bold(`  ${manifest}`) + chalk.dim(`  (${list.length})`))
        const byKind = new Map<string, typeof list>()
        for (const i of list) {
          const arr = byKind.get(i.kind) ?? []
          arr.push(i)
          byKind.set(i.kind, arr)
        }
        for (const kind of ['missing', 'devOnly', 'declared-unused'] as const) {
          const group = byKind.get(kind)
          if (!group || group.length === 0) continue
          const icon = kind === 'missing' ? chalk.red('✗')
                     : kind === 'devOnly' ? chalk.blue('◐')
                     : chalk.yellow('–')
          for (const i of group) {
            const loc = i.declaredIn ? chalk.dim(` [${i.declaredIn}]`) : ''
            console.log(`    ${icon} ${kind.padEnd(16)} ${i.packageName}${loc}`)
            if (i.importers.length > 0 && i.importers.length <= 3) {
              console.log(chalk.dim(`        ${i.importers.join(', ')}`))
            } else if (i.importers.length > 3) {
              console.log(chalk.dim(`        ${i.importers.slice(0, 3).join(', ')} … +${i.importers.length - 3}`))
            }
          }
        }
        console.log()
      }
    }

    // Barrels summary
    console.log(chalk.bold(`  Barrels\n`))
    if (barrels.length === 0) {
      console.log(chalk.dim('  No barrel files detected.\n'))
    } else {
      console.log(`  Total barrels: ${barrels.length} · ${chalk.yellow(String(lowValueBarrels.length))} low-value (< 2 consumers)`)
      if (lowValueBarrels.length > 0) {
        console.log()
        for (const b of lowValueBarrels) {
          console.log(`    ${chalk.yellow('◐')} ${b.file}`)
          console.log(chalk.dim(`        ${b.reExportCount} re-exports · ${b.consumerCount} consumer(s)`))
        }
      }
      console.log()
    }

    process.exit(filtered.some((i) => i.kind === 'missing') ? 1 : 0)
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
    if (opts.listRules) {
      console.log(chalk.bold('\n  CodeGraph Check — available rules\n'))
      for (const r of ALL_RULES) {
        const sev = r.defaultSeverity === 'error'
          ? chalk.red('error')
          : r.defaultSeverity === 'warn'
            ? chalk.yellow('warn')
            : chalk.dim('off')
        console.log(`  ${chalk.bold(r.name.padEnd(35))} ${sev.padEnd(14)} ${chalk.dim(r.description)}`)
      }
      console.log()
      return
    }

    const config = await loadConfig(opts)
    const against: string = opts.against
    // --json : toute la progression va sur stderr pour garder stdout = JSON pur.
    const progress = (msg: string): void => {
      if (opts.json) console.error(msg)
      else console.log(msg)
    }

    // Résoudre le snapshot "before" — soit un fichier .json, soit un git ref.
    let before: GraphSnapshot
    if (against.endsWith('.json')) {
      before = JSON.parse(await fs.readFile(against, 'utf-8'))
    } else {
      progress(chalk.dim(`\n  Analyzing reference ${against}...`))
      before = await analyzeAtRef(against, config)
    }

    progress(chalk.dim(`  Analyzing current tree...`))
    const after = (await analyze(config)).snapshot

    const result = runCheck(before, after, config.rules ?? {})

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2))
      process.exit(result.passed ? 0 : 1)
    }

    console.log(chalk.bold('\n  CodeGraph Check\n'))
    console.log(`  ${chalk.dim('ref')}    ${against}  ${chalk.dim('→')}  ${chalk.dim('current tree')}`)
    console.log(`  ${chalk.dim('rules')}  ${result.rulesRun.join(', ')}`)
    console.log()

    if (result.violations.length === 0) {
      console.log(chalk.green('  ✓ No violations.\n'))
      process.exit(0)
    }

    for (const v of result.violations) {
      const tag = v.severity === 'error' ? chalk.red('✗ error') : chalk.yellow('⚠ warn ')
      console.log(`  ${tag}  ${chalk.bold(v.rule)}`)
      console.log(`           ${v.message}`)
      console.log()
    }

    const summary = `${result.counts.error} error(s), ${result.counts.warn} warning(s)`
    console.log(result.passed ? chalk.yellow(`  ${summary}\n`) : chalk.red(`  ${summary}\n`))
    process.exit(result.passed ? 0 : 1)
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
    const port = parseInt(opts.port, 10)
    const config = await loadConfig(opts)
    // `import.meta.dirname` n'existe qu'à partir de Node 20.11 ; fileURLToPath
    // est portable sur 20.9+ (contrainte de l'env de dev Sentinel).
    const { fileURLToPath } = await import('node:url')
    const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web')
    const { execSync } = await import('node:child_process')

    // Preload snapshot and/or diff into web dir
    if (opts.snapshot) {
      await fs.writeFile(
        path.join(webDir, 'snapshot.json'),
        await fs.readFile(opts.snapshot, 'utf-8')
      )
    }
    if (opts.diff) {
      await fs.writeFile(
        path.join(webDir, 'diff.json'),
        await fs.readFile(opts.diff, 'utf-8')
      )
    }

    // ── API Helpers ──

    function jsonResponse(res: import('node:http').ServerResponse, data: unknown, status = 200) {
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      })
      res.end(JSON.stringify(data))
    }

    function errorResponse(res: import('node:http').ServerResponse, msg: string, status = 500) {
      jsonResponse(res, { error: msg }, status)
    }

    // ── HTTP Server with API routes + static fallback ──

    const { createServer } = await import('node:http')
    const handler = (await import('serve-handler')).default

    const server = createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${port}`)
      const pathname = url.pathname

      // CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST',
          'Access-Control-Allow-Headers': 'Content-Type',
        })
        res.end()
        return
      }

      try {
        // ── GET /api/snapshots — list available snapshots
        if (pathname === '/api/snapshots') {
          const snapshotDir = config.snapshotDir
          try {
            const files = await fs.readdir(snapshotDir)
            const snapshots = files
              .filter(f => f.startsWith('snapshot-') && f.endsWith('.json'))
              .sort()
              .reverse()

            const items = await Promise.all(snapshots.map(async f => {
              const filePath = path.join(snapshotDir, f)
              const stat = await fs.stat(filePath)
              // Extract commit hash and timestamp from filename
              // Format: snapshot-YYYY-MM-DDTHH-MM-SS-abcdef1.json
              const match = f.match(/^snapshot-(.+?)(?:-([a-f0-9]{7,}))?\.json$/)
              return {
                file: f,
                path: filePath,
                timestamp: match?.[1]?.replace(/T/, ' ').replace(/-/g, (m, i) => i > 9 ? ':' : '-') || f,
                commitHash: match?.[2] || null,
                size: stat.size,
                mtime: stat.mtime.toISOString(),
              }
            }))

            jsonResponse(res, { snapshots: items })
          } catch {
            jsonResponse(res, { snapshots: [] })
          }
          return
        }

        // ── GET /api/branches — list git branches
        if (pathname === '/api/branches') {
          try {
            const raw = execSync('git branch -a --format="%(refname:short)|%(objectname:short)|%(committerdate:iso8601)|%(subject)"', {
              cwd: config.rootDir, encoding: 'utf-8', timeout: 10000,
            })
            const currentRaw = execSync('git branch --show-current', {
              cwd: config.rootDir, encoding: 'utf-8', timeout: 5000,
            }).trim()

            const branches = raw.trim().split('\n').filter(Boolean).map(line => {
              const [name, hash, date, ...msgParts] = line.split('|')
              return {
                name: name.trim(),
                hash: hash.trim(),
                date: date.trim(),
                message: msgParts.join('|').trim(),
                current: name.trim() === currentRaw,
              }
            })

            // Also get recent commits for quick ref picking
            const logRaw = execSync('git log --oneline -20', {
              cwd: config.rootDir, encoding: 'utf-8', timeout: 10000,
            })
            const recentCommits = logRaw.trim().split('\n').filter(Boolean).map(line => {
              const [hash, ...msgParts] = line.split(' ')
              return { hash, message: msgParts.join(' ') }
            })

            jsonResponse(res, { branches, current: currentRaw, recentCommits })
          } catch (e: any) {
            errorResponse(res, `Git error: ${e.message}`, 500)
          }
          return
        }

        // ── GET /api/snapshot?file=...  — load a specific snapshot
        if (pathname === '/api/snapshot') {
          const file = url.searchParams.get('file')
          if (!file) { errorResponse(res, 'Missing ?file= parameter', 400); return }
          const filePath = path.join(config.snapshotDir, path.basename(file))
          try {
            const data = await fs.readFile(filePath, 'utf-8')
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
            res.end(data)
          } catch {
            errorResponse(res, 'Snapshot not found', 404)
          }
          return
        }

        // ── GET /api/diff?before=...&after=... — compute diff between two snapshots or refs
        if (pathname === '/api/diff') {
          const beforeArg = url.searchParams.get('before')
          const afterArg = url.searchParams.get('after')
          if (!beforeArg) { errorResponse(res, 'Missing ?before= parameter', 400); return }

          let before: GraphSnapshot
          let after: GraphSnapshot

          // Resolve "before" — snapshot file or git ref
          if (beforeArg.endsWith('.json')) {
            const p = path.isAbsolute(beforeArg) ? beforeArg : path.join(config.snapshotDir, path.basename(beforeArg))
            before = JSON.parse(await fs.readFile(p, 'utf-8'))
          } else {
            before = await analyzeAtRef(beforeArg, config)
          }

          // Resolve "after" — snapshot file, git ref, or current tree
          if (!afterArg || afterArg === 'current') {
            after = (await analyze(config)).snapshot
          } else if (afterArg.endsWith('.json')) {
            const p = path.isAbsolute(afterArg) ? afterArg : path.join(config.snapshotDir, path.basename(afterArg))
            after = JSON.parse(await fs.readFile(p, 'utf-8'))
          } else {
            after = await analyzeAtRef(afterArg, config)
          }

          const diff = CodeGraph.diff(before, after)

          // Also save to web dir so viewer can reload
          await fs.writeFile(path.join(webDir, 'snapshot.json'), JSON.stringify(after, null, 2))
          await fs.writeFile(path.join(webDir, 'diff.json'), JSON.stringify(diff, null, 2))

          jsonResponse(res, { diff, snapshot: after })
          return
        }

        // ── GET /api/analyze?ref=...  — run analysis at a ref (or current tree)
        if (pathname === '/api/analyze') {
          const ref = url.searchParams.get('ref')
          let snapshot: GraphSnapshot

          if (ref && ref !== 'current') {
            snapshot = await analyzeAtRef(ref, config)
          } else {
            const result = await analyze(config)
            snapshot = result.snapshot
            // Save as new snapshot
            const outPath = await defaultSnapshotPath(config)
            await fs.mkdir(path.dirname(outPath), { recursive: true })
            await fs.writeFile(outPath, JSON.stringify(snapshot, null, 2))
          }

          await fs.writeFile(path.join(webDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2))
          // Clear diff when loading a fresh snapshot
          try { await fs.unlink(path.join(webDir, 'diff.json')) } catch { /* no diff.json to clear — fine */ }

          jsonResponse(res, { snapshot })
          return
        }

        // ── Static file fallback ──
        return handler(req, res, { public: webDir })

      } catch (e: any) {
        errorResponse(res, e.message || 'Internal error', 500)
      }
    })

    server.listen(port, () => {
      console.log(chalk.bold(`\n🌐 CodeGraph Viewer`))
      console.log(`   ${chalk.cyan(`http://localhost:${port}`)}\n`)
      console.log(chalk.dim('   API endpoints:'))
      console.log(chalk.dim('     GET /api/snapshots       — list saved snapshots'))
      console.log(chalk.dim('     GET /api/branches        — list git branches + recent commits'))
      console.log(chalk.dim('     GET /api/snapshot?file=  — load a snapshot'))
      console.log(chalk.dim('     GET /api/diff?before=&after=  — compute diff'))
      console.log(chalk.dim('     GET /api/analyze?ref=    — run analysis\n'))
      console.log(chalk.dim('   Press Ctrl+C to stop\n'))
    })
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
