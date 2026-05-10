/**
 * `codegraph reach` — find transitive import paths between glob patterns.
 *
 * Extrait du god-file `cli/index.ts` (P2b split).
 */

import chalk from 'chalk'
import { findReachablePaths, globToRegex } from '../../graph/reachability.js'
import { loadSnapshot } from '../_shared.js'

export interface ReachOpts {
  config?: string
  json?: boolean
  max: string
}

export async function runReachCommand(
  fromGlob: string,
  toGlob: string,
  opts: ReachOpts,
): Promise<void> {
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
}
