/**
 * `codegraph taint` — display taint violations from the latest snapshot.
 *
 * Extrait du god-file `cli/index.ts` (P2b split).
 */

import chalk from 'chalk'
import { loadSnapshot } from '../_shared.js'

export interface TaintOpts {
  config?: string
  json?: boolean
  severity: string
}

export async function runTaintCommand(
  snapshotPath: string | undefined,
  opts: TaintOpts,
): Promise<void> {
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
}
