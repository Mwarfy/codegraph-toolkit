#!/usr/bin/env node

/**
 * CodeGraph CLI
 *
 * Commands:
 *   analyze   Run all detectors, generate snapshot JSON
 *   diff      Compare two snapshots, show what changed
 *   orphans   List orphan nodes from a snapshot
 *   serve     Start a local HTTP server for the web viewer
 */

import { Command } from 'commander'
import chalk from 'chalk'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { analyze } from '../core/analyzer.js'
import { CodeGraph } from '../core/graph.js'
import type { CodeGraphConfig, GraphSnapshot } from '../core/types.js'
import { listDetectorNames, defaultDetectorNames } from '../detectors/index.js'
import { buildSynopsis, renderLevel1, renderLevel2, renderLevel3 } from '../synopsis/builder.js'
import { collectAdrMarkers } from '../synopsis/adr-markers.js'
import { buildMap } from '../map/builder.js'
import { runCheck, ALL_RULES } from '../check/index.js'
import { buildStructuralDiff, renderStructuralDiffMarkdown } from '../diff/index.js'
import { findReachablePaths, globToRegex } from '../graph/reachability.js'
import { computeDsm } from '../graph/dsm.js'
import { renderDsm, aggregateByContainer } from '../map/dsm-renderer.js'

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
  .action(async (opts) => {
    const config = await loadConfig(opts)

    console.log(chalk.bold('\n🔍 CodeGraph — Analyzing...\n'))
    console.log(`  Root:       ${config.rootDir}`)
    console.log(`  Include:    ${config.include.join(', ')}`)
    console.log(`  Detectors:  ${config.detectors.join(', ')}`)
    console.log()

    const result = await analyze(config)
    const { snapshot, timing } = result

    // Print summary
    console.log(chalk.bold('  Results:\n'))
    console.log(`  Files:      ${snapshot.stats.totalFiles}`)
    console.log(`  Edges:      ${snapshot.stats.totalEdges}`)
    console.log(`  Orphans:    ${chalk.yellow(String(snapshot.stats.orphanCount))}`)
    console.log(`  Connected:  ${chalk.green(String(snapshot.stats.connectedCount))}`)
    console.log(`  Entry pts:  ${snapshot.stats.entryPointCount}`)
    console.log(`  Uncertain:  ${snapshot.stats.uncertainCount}`)
    console.log(`  Health:     ${formatHealth(snapshot.stats.healthScore)}`)
    console.log()

    // Edge breakdown
    console.log(chalk.bold('  Edges by type:'))
    for (const [type, count] of Object.entries(snapshot.stats.edgesByType)) {
      if (count > 0) {
        console.log(`    ${type.padEnd(15)} ${count}`)
      }
    }
    console.log()

    // Unused exports summary with confidence
    const filesWithExports = snapshot.nodes.filter(n => n.exports && n.exports.length > 0)
    if (filesWithExports.length > 0) {
      const totalExports = filesWithExports.reduce((s, n) => s + n.exports!.length, 0)
      const conf = { safe: 0, test: 0, dynamic: 0, local: 0 }
      for (const n of filesWithExports) {
        for (const e of n.exports!) {
          if ((e as any).confidence === 'safe-to-remove') conf.safe++
          else if ((e as any).confidence === 'test-only') conf.test++
          else if ((e as any).confidence === 'possibly-dynamic') conf.dynamic++
          else if ((e as any).confidence === 'local-only') conf.local++
        }
      }
      const totalUnused = conf.safe + conf.test + conf.dynamic + conf.local

      console.log(chalk.bold('  Exports:'))
      console.log(`    Analyzed:     ${totalExports} symbols across ${filesWithExports.length} files`)
      if (totalUnused > 0) {
        console.log(`    ${chalk.red(String(conf.safe))} safe to remove · ${chalk.magenta(String(conf.local))} local-only · ${chalk.blue(String(conf.test))} test-only · ${chalk.yellow(String(conf.dynamic))} possibly dynamic`)

        const ranked = filesWithExports
          .map(n => ({
            file: n.id,
            safe: n.exports!.filter((e: any) => e.confidence === 'safe-to-remove').length,
            total: n.exports!.length,
          }))
          .filter(r => r.safe > 0)
          .sort((a, b) => b.safe - a.safe)
          .slice(0, 5)

        if (ranked.length > 0) {
          console.log(chalk.dim('    Top dead-export files:'))
          for (const r of ranked) {
            console.log(chalk.dim(`      ${r.safe}/${r.total} safe  ${r.file}`))
          }
        }
      } else {
        console.log(`    Unused:       ${chalk.green('0')} — all exports are consumed!`)
      }
      console.log()
    }

    // Timing
    console.log(chalk.dim(`  Timing:`))
    console.log(chalk.dim(`    File discovery: ${timing.fileDiscovery.toFixed(0)}ms`))
    for (const [name, ms] of Object.entries(timing.detectors)) {
      console.log(chalk.dim(`    ${name}: ${(ms as number).toFixed(0)}ms`))
    }
    console.log(chalk.dim(`    Graph build:    ${timing.graphBuild.toFixed(0)}ms`))
    console.log(chalk.dim(`    Total:          ${timing.total.toFixed(0)}ms`))
    console.log()

    // Save or print
    if (opts.save !== false) {
      const outPath = opts.output || await defaultSnapshotPath(config)
      await fs.mkdir(path.dirname(outPath), { recursive: true })
      await fs.writeFile(outPath, JSON.stringify(snapshot, null, 2))
      console.log(chalk.green(`  ✓ Snapshot saved: ${outPath}\n`))

      // Prune anciens snapshots. config.maxSnapshots définit le cap (default 50).
      // On garde les N plus récents par nom de fichier (timestamp lex-sortable),
      // on delete les autres. Idempotent + silencieux.
      const pruned = await pruneSnapshots(path.dirname(outPath), config.maxSnapshots)
      if (pruned > 0) {
        console.log(chalk.dim(`  ✓ Pruned ${pruned} old snapshot(s) (kept ${config.maxSnapshots})\n`))
      }

      // Dérivatifs ADR-009 : synopsis.json (source de vérité structurée) +
      // synopsis-level{1,2}.md + synopsis-level3-<container>.md pour chaque
      // container détecté. L'ensemble est régénéré à chaque analyze — pas de
      // cache périmé possible. synopsis.md reste un alias de level1 (quick read).
      //
      // Lien 1+2 ADR-toolkit : collecte les marqueurs `// ADR-NNN` du code
      // et les passe au builder. Hors-builder pour préserver la pureté
      // (cf. ADR-009 — projection déterministe, pas d'I/O dans le builder).
      const adrMarkers = await collectAdrMarkers(config.rootDir)
      const synopsis = buildSynopsis(snapshot, { adrMarkers })
      const snapDir = path.dirname(outPath)
      await fs.writeFile(path.join(snapDir, 'synopsis.json'), JSON.stringify(synopsis, null, 2))
      const l1 = renderLevel1(synopsis)
      await fs.writeFile(path.join(snapDir, 'synopsis-level1.md'), l1)
      await fs.writeFile(path.join(snapDir, 'synopsis.md'), l1)
      await fs.writeFile(path.join(snapDir, 'synopsis-level2.md'), renderLevel2(synopsis))
      for (const c of synopsis.containers) {
        await fs.writeFile(
          path.join(snapDir, `synopsis-level3-${c.id}.md`),
          renderLevel3(synopsis, c.id),
        )
      }
      console.log(chalk.green(`  ✓ Synopsis written: synopsis.json + ${synopsis.containers.length + 2} markdown files in ${snapDir}\n`))

      if (opts.map) {
        const mapContent = buildMap(snapshot, { concerns: config.concerns })
        const mapPath = path.join(config.rootDir, 'MAP.md')
        await fs.writeFile(mapPath, mapContent)
        const approxTokens = Math.round(mapContent.length / 4)
        console.log(chalk.green(`  ✓ MAP.md written: ${mapPath} (~${approxTokens} tokens)\n`))
      }
    } else {
      process.stdout.write(JSON.stringify(snapshot, null, 2))
    }
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
        try { await fs.access(p); rulesPath = p; break } catch {}
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

      const counts = { 'declared-unused': 0, missing: 0, devOnly: 0 }
      for (const i of filtered) counts[i.kind]++
      console.log(`  ${chalk.red(String(counts.missing))} missing · ${chalk.yellow(String(counts['declared-unused']))} declared-unused · ${chalk.blue(String(counts.devOnly))} devOnly`)
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
  .action(async (beforeArg, afterArg, opts) => {
    const config = await loadConfig(opts)

    // Resolve "before" snapshot
    let before: GraphSnapshot
    let after: GraphSnapshot

    if (!beforeArg) {
      // No args: compare latest two snapshots
      const snapshots = await listSnapshots(config.snapshotDir)
      if (snapshots.length < 2) {
        console.error(chalk.red('Need at least 2 snapshots to diff. Run "codegraph analyze" first.'))
        process.exit(1)
      }
      before = JSON.parse(await fs.readFile(snapshots[1], 'utf-8'))
      after = JSON.parse(await fs.readFile(snapshots[0], 'utf-8'))
    } else if (beforeArg.endsWith('.json')) {
      // Both are file paths
      before = JSON.parse(await fs.readFile(beforeArg, 'utf-8'))
      after = afterArg
        ? JSON.parse(await fs.readFile(afterArg, 'utf-8'))
        : (await analyze(config)).snapshot
    } else {
      // Git refs — analyze at each ref
      // stdout reste propre si --md ou --json (output machine) : on route
      // la progression sur stderr dans ces cas.
      const writesToStdout = opts.md || opts.json
      const progress = (msg: string): void => {
        if (writesToStdout) console.error(msg)
        else console.log(msg)
      }
      progress(chalk.dim(`\n  Analyzing at ${beforeArg}...`))
      before = await analyzeAtRef(beforeArg, config)
      if (afterArg && !afterArg.endsWith('.json')) {
        progress(chalk.dim(`  Analyzing at ${afterArg}...`))
        after = await analyzeAtRef(afterArg, config)
      } else if (afterArg) {
        after = JSON.parse(await fs.readFile(afterArg, 'utf-8'))
      } else {
        progress(chalk.dim(`  Analyzing current tree...`))
        after = (await analyze(config)).snapshot
      }
    }

    // ── Structural diff (phase 3) ──
    if (opts.structural || opts.md) {
      const structural = buildStructuralDiff(before, after)
      if (opts.md) {
        process.stdout.write(renderStructuralDiffMarkdown(structural))
        return
      }
      if (opts.json) {
        console.log(JSON.stringify(structural, null, 2))
        return
      }
      // default structural output = markdown (lisible humain)
      process.stdout.write(renderStructuralDiffMarkdown(structural))
      return
    }

    const diff = CodeGraph.diff(before, after)

    // ── JSON output
    if (opts.json) {
      console.log(JSON.stringify(diff, null, 2))
      return
    }

    // ── Viewer mode: write diff + snapshots and launch server
    if (opts.viewer) {
      // `import.meta.dirname` n'existe qu'à partir de Node 20.11 ; fileURLToPath
      // est portable sur 20.9+ (contrainte de l'env de dev Sentinel).
      const { fileURLToPath } = await import('node:url')
      const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web')
      await fs.writeFile(path.join(webDir, 'snapshot.json'), JSON.stringify(after, null, 2))
      await fs.writeFile(path.join(webDir, 'diff.json'), JSON.stringify(diff, null, 2))
      console.log(chalk.green(`  ✓ diff.json written for viewer`))
      // Print summary then tell user to serve
      printDiffSummary(diff, opts.report)
      console.log(chalk.cyan(`  Run: codegraph serve  →  open viewer with diff overlay\n`))
      return
    }

    // ── Standard textual output
    printDiffSummary(diff, opts.report)
  })

function printDiffSummary(diff: import('../core/types.js').SnapshotDiff, extended?: boolean): void {
  console.log(chalk.bold('\n  CodeGraph Diff\n'))
  console.log(`  ${chalk.dim('from')} ${diff.fromCommit || '?'}  ${chalk.dim('→')}  ${diff.toCommit || '?'}`)
  console.log()

  const s = diff.summary

  // Compact summary line
  const parts: string[] = []
  if (s.addedFiles > 0) parts.push(chalk.green(`+${s.addedFiles} files`))
  if (s.removedFiles > 0) parts.push(chalk.red(`-${s.removedFiles} files`))
  if (s.addedEdges > 0) parts.push(chalk.green(`+${s.addedEdges} edges`))
  if (s.removedEdges > 0) parts.push(chalk.red(`-${s.removedEdges} edges`))
  if (parts.length > 0) console.log(`  ${parts.join('  ')}`)
  else console.log(chalk.dim('  No changes'))
  console.log()

  // Extended: list added/removed files
  if (extended) {
    if (diff.addedNodes.length > 0) {
      console.log(chalk.green('  Added files:'))
      for (const n of diff.addedNodes) {
        const tags = n.tags.length ? chalk.dim(` [${n.tags.join(',')}]`) : ''
        console.log(`    ${chalk.green('+')} ${n.id}${tags}`)
      }
      console.log()
    }
    if (diff.removedNodes.length > 0) {
      console.log(chalk.red('  Removed files:'))
      for (const n of diff.removedNodes) {
        console.log(`    ${chalk.red('-')} ${n.id}`)
      }
      console.log()
    }
    if (diff.addedEdges.length > 0) {
      console.log(chalk.green('  New connections:'))
      const shown = diff.addedEdges.filter(e => e.type !== 'import').slice(0, 20)
      for (const e of shown) {
        console.log(`    ${chalk.dim(e.type.padEnd(13))} ${e.from} → ${e.to}`)
      }
      const importCount = diff.addedEdges.filter(e => e.type === 'import').length
      if (importCount > 0) console.log(chalk.dim(`    + ${importCount} import edges`))
      if (diff.addedEdges.length > shown.length + importCount) {
        console.log(chalk.dim(`    + ${diff.addedEdges.length - shown.length - importCount} more...`))
      }
      console.log()
    }
  }

  // Orphans
  if (diff.newOrphans.length > 0) {
    console.log(chalk.yellow(`  ⚠ ${diff.newOrphans.length} new orphan(s):`))
    for (const id of diff.newOrphans) {
      console.log(`    ${chalk.red('●')} ${id}`)
    }
    console.log()
  }

  if (diff.resolvedOrphans.length > 0) {
    console.log(chalk.green(`  ✓ ${diff.resolvedOrphans.length} orphan(s) resolved:`))
    for (const id of diff.resolvedOrphans) {
      console.log(`    ${chalk.green('●')} ${id}`)
    }
    console.log()
  }

  const healthDelta = s.healthAfter - s.healthBefore
  const arrow = healthDelta > 0 ? chalk.green('▲') : healthDelta < 0 ? chalk.red('▼') : '='
  console.log(`  Health: ${formatHealth(s.healthBefore)} → ${formatHealth(s.healthAfter)} ${arrow}`)
  console.log()
}

/**
 * Run codegraph analyze on a past git ref by temporarily checking out
 * a worktree, running analyze, then cleaning up.
 */
async function analyzeAtRef(ref: string, config: CodeGraphConfig): Promise<GraphSnapshot> {
  const { execSync } = await import('node:child_process')
  const tmpDir = path.join(config.rootDir, '.codegraph', `_worktree_${Date.now()}`)

  try {
    // Resolve the ref to a commit hash
    const hash = execSync(`git rev-parse ${ref}`, {
      cwd: config.rootDir, encoding: 'utf-8'
    }).trim()

    // Create a temporary git worktree
    execSync(`git worktree add --detach "${tmpDir}" ${hash}`, {
      cwd: config.rootDir, encoding: 'utf-8', stdio: 'pipe'
    })

    // Build a temporary config pointing at the worktree
    const tmpConfig: CodeGraphConfig = {
      ...config,
      rootDir: tmpDir,
      snapshotDir: path.join(tmpDir, '.codegraph'),
    }

    const result = await analyze(tmpConfig)
    // Override commit info with the actual ref
    result.snapshot.commitHash = hash.slice(0, 7)

    return result.snapshot
  } finally {
    // Clean up the worktree
    try {
      execSync(`git worktree remove --force "${tmpDir}"`, {
        cwd: config.rootDir, encoding: 'utf-8', stdio: 'pipe'
      })
    } catch {
      // If worktree removal fails, try direct cleanup
      try { await fs.rm(tmpDir, { recursive: true }); } catch {}
      try { execSync(`git worktree prune`, { cwd: config.rootDir, stdio: 'pipe' }); } catch {}
    }
  }
}

async function listSnapshots(snapshotDir: string): Promise<string[]> {
  try {
    const files = await fs.readdir(snapshotDir)
    return files
      .filter(f => f.startsWith('snapshot-') && f.endsWith('.json'))
      .sort()
      .reverse()
      .map(f => path.join(snapshotDir, f))
  } catch {
    return []
  }
}

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
          try { await fs.unlink(path.join(webDir, 'diff.json')) } catch {}

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

// ─── Helpers ──────────────────────────────────────────────────────────────

async function loadConfig(opts: { config?: string; root?: string; detectors?: string }): Promise<CodeGraphConfig> {
  // Apply sensible defaults to a partial config (detectors, snapshotDir,
  // maxSnapshots, include/exclude/entryPoints if missing). Mutates + returns.
  const applyDefaults = (cfg: Partial<CodeGraphConfig> & { rootDir: string }): CodeGraphConfig => {
    return {
      rootDir: cfg.rootDir,
      include: cfg.include ?? ['**/*.ts', '**/*.tsx'],
      exclude: cfg.exclude ?? [
        '**/node_modules/**', '**/dist/**', '**/build/**',
        '**/*.test.ts', '**/*.spec.ts', '**/test/**',
        '**/*.d.ts',
      ],
      entryPoints: cfg.entryPoints ?? ['**/server.ts', '**/main.ts', '**/index.ts'],
      detectors: cfg.detectors ?? defaultDetectorNames(),
      snapshotDir: cfg.snapshotDir ?? path.join(cfg.rootDir, '.codegraph'),
      maxSnapshots: cfg.maxSnapshots ?? 50,
      tsconfigPath: cfg.tsconfigPath,
      detectorOptions: cfg.detectorOptions,
      rules: cfg.rules,
      concerns: cfg.concerns,
    }
  }

  // Try to load config file
  if (opts.config) {
    const configPath = path.resolve(opts.config)
    if (configPath.endsWith('.json')) {
      const raw = JSON.parse(await fs.readFile(configPath, 'utf-8'))
      // Resolve rootDir relative to config file location
      if (raw.rootDir && !path.isAbsolute(raw.rootDir)) {
        raw.rootDir = path.resolve(path.dirname(configPath), raw.rootDir)
      }
      // --root override : permet au caller d'utiliser la même config (include,
      // entryPoints, detectors) mais de pointer vers un autre checkout du code.
      if (opts.root) {
        raw.rootDir = path.resolve(opts.root)
        if (!raw.snapshotDir || !path.isAbsolute(raw.snapshotDir)) {
          raw.snapshotDir = path.join(raw.rootDir, raw.snapshotDir || '.codegraph')
        }
      } else if (raw.snapshotDir && !path.isAbsolute(raw.snapshotDir)) {
        raw.snapshotDir = path.resolve(path.dirname(configPath), raw.snapshotDir)
      }
      return applyDefaults(raw)
    }
    const mod = await import(configPath)
    return applyDefaults(mod.default || mod)
  }

  // Try default config locations
  const root = path.resolve(opts.root || '.')
  const defaultPaths = [
    path.join(root, 'codegraph.config.ts'),
    path.join(root, 'codegraph.config.js'),
    path.join(root, 'codegraph.config.json'),
  ]

  for (const p of defaultPaths) {
    try {
      await fs.access(p)
      if (p.endsWith('.json')) {
        const raw = JSON.parse(await fs.readFile(p, 'utf-8'))
        if (raw.rootDir && !path.isAbsolute(raw.rootDir)) {
          raw.rootDir = path.resolve(path.dirname(p), raw.rootDir)
        } else if (!raw.rootDir) {
          raw.rootDir = root
        }
        return applyDefaults(raw)
      }
      const mod = await import(p)
      return applyDefaults({ rootDir: root, ...(mod.default || mod) })
    } catch {
      // Try next
    }
  }

  // Fallback to sensible defaults
  const detectorNames = opts.detectors
    ? opts.detectors.split(',').map(s => s.trim())
    : listDetectorNames()

  return {
    rootDir: root,
    include: ['**/*.ts', '**/*.tsx'],
    exclude: [
      '**/node_modules/**', '**/dist/**', '**/build/**',
      '**/*.test.ts', '**/*.spec.ts', '**/test/**',
      '**/*.d.ts',
    ],
    entryPoints: [
      '**/server.ts', '**/main.ts', '**/index.ts',
    ],
    detectors: detectorNames,
    snapshotDir: path.join(root, '.codegraph'),
    maxSnapshots: 50,
  }
}

async function loadSnapshot(
  snapshotPath?: string,
  opts?: { config?: string }
): Promise<GraphSnapshot> {
  if (snapshotPath) {
    return JSON.parse(await fs.readFile(snapshotPath, 'utf-8'))
  }

  // Find the latest snapshot in the default dir
  const config = await loadConfig(opts || {})
  const snapshotDir = config.snapshotDir

  try {
    const files = await fs.readdir(snapshotDir)
    // Filtre strict sur `snapshot-*.json` pour ne pas collecter les dérivés
    // synopsis.json et diff.json qui vivent dans le même dossier.
    const snapshots = files
      .filter(f => f.startsWith('snapshot-') && f.endsWith('.json'))
      .sort()
      .reverse()

    if (snapshots.length === 0) {
      console.error(chalk.red('No snapshots found. Run "codegraph analyze" first.'))
      process.exit(1)
    }

    return JSON.parse(
      await fs.readFile(path.join(snapshotDir, snapshots[0]), 'utf-8')
    )
  } catch {
    console.error(chalk.red(`Snapshot directory not found: ${snapshotDir}`))
    console.error(chalk.dim('Run "codegraph analyze" first to generate a snapshot.'))
    process.exit(1)
  }
}

/**
 * Keeps the most recent `keep` snapshots in `dir`, deletes the rest.
 * Returns the number deleted. Only touches files matching `snapshot-*.json`.
 */
async function pruneSnapshots(dir: string, keep: number): Promise<number> {
  if (!Number.isFinite(keep) || keep <= 0) return 0
  let files: string[]
  try {
    files = await fs.readdir(dir)
  } catch {
    return 0
  }
  const snapshots = files
    .filter(f => f.startsWith('snapshot-') && f.endsWith('.json'))
    .sort()                                                           // timestamp lex-sortable
    .reverse()                                                        // newest first
  if (snapshots.length <= keep) return 0
  const toDelete = snapshots.slice(keep)
  let deleted = 0
  for (const f of toDelete) {
    try {
      await fs.unlink(path.join(dir, f))
      deleted++
    } catch {
      // skip silently — one stale file shouldn't break the analyze
    }
  }
  return deleted
}

async function defaultSnapshotPath(config: CodeGraphConfig): Promise<string> {
  const dir = config.snapshotDir
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

  // Include commit hash if available
  let suffix = ''
  try {
    const { execSync } = await import('node:child_process')
    suffix = '-' + execSync('git rev-parse --short HEAD', {
      cwd: config.rootDir, encoding: 'utf-8'
    }).trim()
  } catch {
    // Not a git repo
  }

  return path.join(dir, `snapshot-${timestamp}${suffix}.json`)
}

function formatHealth(score: number): string {
  const pct = Math.round(score * 100)
  if (pct >= 90) return chalk.green(`${pct}%`)
  if (pct >= 70) return chalk.yellow(`${pct}%`)
  return chalk.red(`${pct}%`)
}

// ─── Run ──────────────────────────────────────────────────────────────────

program.parse()
