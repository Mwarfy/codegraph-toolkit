/**
 * `codegraph taint` — display taint violations from the latest snapshot.
 *
 * Extrait du god-file `cli/index.ts` (P2b split).
 */

import chalk from 'chalk'
import { loadSnapshot } from '../_shared.js'
import type { TaintViolation } from '../../core/types.js'

export interface TaintOpts {
  config?: string
  json?: boolean
  severity: string
}

/** Sévérités du moins au plus grave (index = gravité). */
const SEVERITY_ORDER = ['low', 'medium', 'high', 'critical'] as const

/** Garde les violations dont la sévérité est >= au seuil demandé (ordre préservé). */
export function filterBySeverity(violations: TaintViolation[], minSeverity: string): TaintViolation[] {
  const minIdx = SEVERITY_ORDER.indexOf(minSeverity as (typeof SEVERITY_ORDER)[number])
  return violations.filter((v) => SEVERITY_ORDER.indexOf(v.severity) >= minIdx)
}

/** Compte les violations par sévérité (toutes présentes, zéro si absente). */
export function countBySeverity(
  violations: TaintViolation[],
): Record<'critical' | 'high' | 'medium' | 'low', number> {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const v of violations) counts[v.severity]++
  return counts
}

export async function runTaintCommand(
  snapshotPath: string | undefined,
  opts: TaintOpts,
): Promise<void> {
  const snapshot = await loadSnapshot(snapshotPath, opts)
  const filtered = filterBySeverity(snapshot.taintViolations ?? [], opts.severity)

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

  printSeverityCounts(filtered)
  for (const v of filtered) printTaintViolation(v)
  process.exit(filtered.length > 0 ? 1 : 0)
}

/** Ligne récapitulative des compteurs par sévérité. */
function printSeverityCounts(violations: TaintViolation[]): void {
  const counts = countBySeverity(violations)
  console.log(
    `  ${chalk.red(String(counts.critical))} critical · ` +
    `${chalk.magenta(String(counts.high))} high · ` +
    `${chalk.yellow(String(counts.medium))} medium · ` +
    `${chalk.dim(String(counts.low))} low`,
  )
  console.log()
}

/** Couleur chalk associée à une sévérité. */
function severityColor(severity: string): (s: string) => string {
  return severity === 'critical' ? chalk.red
       : severity === 'high' ? chalk.magenta
       : severity === 'medium' ? chalk.yellow
       : chalk.dim
}

/** Détail d'une violation : en-tête source→sink + trace de la chain. */
function printTaintViolation(v: TaintViolation): void {
  const sevColor = severityColor(v.severity)
  console.log(`  ${sevColor('✗ ' + v.severity.toUpperCase().padEnd(8))} ${chalk.bold(v.sourceName)} → ${chalk.bold(v.sinkName)}`)
  console.log(chalk.dim(`      ${v.file}:${v.line}  ${v.symbol ? `(${v.symbol})` : ''}`))
  for (const step of v.chain) {
    const icon = step.kind === 'source' ? '┌' : step.kind === 'sink' ? '└' : '│'
    console.log(chalk.dim(`      ${icon} L${step.line}  ${step.detail}`))
  }
  console.log()
}
