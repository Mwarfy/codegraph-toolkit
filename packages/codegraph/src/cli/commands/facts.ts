/**
 * `codegraph facts` — export the snapshot as Soufflé Datalog .facts files.
 *
 * Extrait du god-file `cli/index.ts` (P2b split).
 */

import chalk from 'chalk'
import * as path from 'node:path'
import { analyze } from '../../core/analyzer.js'
import type { GraphSnapshot } from '../../core/types.js'
import { exportFacts } from '../../facts/index.js'
import { loadConfig, loadSnapshot } from '../_shared.js'

export interface FactsOpts {
  config?: string
  output?: string
  regen?: boolean
}

export async function runFactsCommand(
  snapshotPath: string | undefined,
  opts: FactsOpts,
): Promise<void> {
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
}
