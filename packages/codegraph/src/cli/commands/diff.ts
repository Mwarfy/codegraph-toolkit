// ADR-005
/**
 * `codegraph diff` — compare deux snapshots ou refs git.
 *
 * Extrait du god-file `cli/index.ts` (P2a split). Inclut les helpers
 * `printDiffSummary`, `analyzeAtRef`, `listSnapshots` qui ne sont
 * utilisés que par cette command.
 */

import chalk from 'chalk'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { analyze } from '../../core/analyzer.js'
import { CodeGraph } from '../../core/graph.js'
import type { CodeGraphConfig, GraphSnapshot, SnapshotDiff } from '../../core/types.js'
import { buildStructuralDiff, renderStructuralDiffMarkdown } from '../../diff/index.js'
import { loadConfig, formatHealth, analyzeAtRef } from '../_shared.js'

export interface DiffOpts {
  config?: string
  json?: boolean
  viewer?: boolean
  report?: boolean
  structural?: boolean
  md?: boolean
}

export async function runDiffCommand(
  beforeArg: string | undefined,
  afterArg: string | undefined,
  opts: DiffOpts,
): Promise<void> {
  const config = await loadConfig(opts)
  const { before, after } = await resolveDiffSnapshots(beforeArg, afterArg, opts, config)

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

  if (opts.json) {
    console.log(JSON.stringify(diff, null, 2))
    return
  }

  if (opts.viewer) {
    // `import.meta.dirname` n'existe qu'à partir de Node 20.11 ; fileURLToPath
    // est portable sur 20.9+ (contrainte de l'env de dev Sentinel).
    const { fileURLToPath } = await import('node:url')
    const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../web')
    await fs.writeFile(path.join(webDir, 'snapshot.json'), JSON.stringify(after, null, 2))
    await fs.writeFile(path.join(webDir, 'diff.json'), JSON.stringify(diff, null, 2))
    console.log(chalk.green(`  ✓ diff.json written for viewer`))
    printDiffSummary(diff, { extended: opts.report })
    console.log(chalk.cyan(`  Run: codegraph serve  →  open viewer with diff overlay\n`))
    return
  }

  printDiffSummary(diff, { extended: opts.report })
}

/**
 * Résout les snapshots `before`/`after` selon les arguments :
 *   - aucun arg : 2 derniers snapshots de `config.snapshotDir`
 *   - path .json : lecture directe
 *   - autre chose : ref git → worktree + analyze
 */
async function resolveDiffSnapshots(
  beforeArg: string | undefined,
  afterArg: string | undefined,
  opts: DiffOpts,
  config: CodeGraphConfig,
): Promise<{ before: GraphSnapshot; after: GraphSnapshot }> {
  if (!beforeArg) {
    // No args: compare latest two snapshots
    const snapshots = await listSnapshots(config.snapshotDir)
    if (snapshots.length < 2) {
      console.error(chalk.red('Need at least 2 snapshots to diff. Run "codegraph analyze" first.'))
      process.exit(1)
    }
    return {
      before: JSON.parse(await fs.readFile(snapshots[1], 'utf-8')),
      after: JSON.parse(await fs.readFile(snapshots[0], 'utf-8')),
    }
  }

  if (beforeArg.endsWith('.json')) {
    const before = JSON.parse(await fs.readFile(beforeArg, 'utf-8'))
    const after = afterArg
      ? JSON.parse(await fs.readFile(afterArg, 'utf-8'))
      : (await analyze(config)).snapshot
    return { before, after }
  }

  // Git refs — analyze at each ref. stdout reste propre si --md ou --json
  // (output machine) : on route la progression sur stderr.
  const writesToStdout = opts.md || opts.json
  const progress = (msg: string): void => {
    if (writesToStdout) console.error(msg)
    else console.log(msg)
  }
  progress(chalk.dim(`\n  Analyzing at ${beforeArg}...`))
  const before = await analyzeAtRef(beforeArg, config)
  let after: GraphSnapshot
  if (afterArg && !afterArg.endsWith('.json')) {
    progress(chalk.dim(`  Analyzing at ${afterArg}...`))
    after = await analyzeAtRef(afterArg, config)
  } else if (afterArg) {
    after = JSON.parse(await fs.readFile(afterArg, 'utf-8'))
  } else {
    progress(chalk.dim(`  Analyzing current tree...`))
    after = (await analyze(config)).snapshot
  }
  return { before, after }
}

function printDiffSummary(diff: SnapshotDiff, opts: { extended?: boolean } = {}): void {
  const { extended } = opts
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
      const shown = diff.addedEdges.filter((e) => e.type !== 'import').slice(0, 20)
      for (const e of shown) {
        console.log(`    ${chalk.dim(e.type.padEnd(13))} ${e.from} → ${e.to}`)
      }
      const importCount = diff.addedEdges.filter((e) => e.type === 'import').length
      if (importCount > 0) console.log(chalk.dim(`    + ${importCount} import edges`))
      if (diff.addedEdges.length > shown.length + importCount) {
        console.log(chalk.dim(`    + ${diff.addedEdges.length - shown.length - importCount} more...`))
      }
      console.log()
    }
  }

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

async function listSnapshots(snapshotDir: string): Promise<string[]> {
  try {
    const files = await fs.readdir(snapshotDir)
    return files
      .filter((f) => f.startsWith('snapshot-') && f.endsWith('.json'))
      .sort()
      .reverse()
      .map((f) => path.join(snapshotDir, f))
  } catch {
    return []
  }
}
