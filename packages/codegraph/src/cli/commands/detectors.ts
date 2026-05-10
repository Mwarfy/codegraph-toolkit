/**
 * `codegraph detectors` — list detectors that ran in the latest analyze.
 *
 * Extrait du god-file `cli/index.ts` (P2b split).
 */

import chalk from 'chalk'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { loadConfig, defaultSnapshotPath } from '../_shared.js'

export async function runDetectorsCommand(): Promise<void> {
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
}
