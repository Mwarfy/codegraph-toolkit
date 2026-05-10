/**
 * `codegraph orphans` — list orphan nodes from a snapshot.
 *
 * Extrait du god-file `cli/index.ts` (P2b split).
 */

import chalk from 'chalk'
import { loadSnapshot, formatHealth } from '../_shared.js'

export interface OrphansOpts {
  config?: string
  json?: boolean
}

export async function runOrphansCommand(
  snapshotPath: string | undefined,
  opts: OrphansOpts,
): Promise<void> {
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
}
