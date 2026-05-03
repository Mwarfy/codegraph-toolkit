// ADR-005
/**
 * `codegraph datalog-check` — exécute toutes les rules .dl contre les
 * facts courants. Avec `--diff`, ne montre que les violations NOUVELLES
 * vs un baseline cached. Avec `--update-baseline`, écrit le baseline.
 *
 * Pattern d'usage post-commit :
 *   1. analyze → régen .codegraph/facts/
 *   2. datalog-check → valide invariants
 *   3. datalog-check --update-baseline → freeze l'état comme baseline
 *
 * Pre-edit Claude hook :
 *   datalog-check --diff --json --timeout 5000
 *   → ne signale que ce qui DÉRIVE depuis le baseline (= dette nouvelle).
 *
 * Extrait du god-file `cli/index.ts` (P2a split).
 */

import chalk from 'chalk'
import * as path from 'node:path'
import { exists } from '../_shared.js'

export interface DatalogCheckOpts {
  rulesDir?: string
  factsDir?: string
  baseline?: string
  diff?: boolean
  updateBaseline?: boolean
  json?: boolean
  timeout?: string
}

type ViolationTuple = [string, string, number, string]

export async function runDatalogCheckCommand(opts: DatalogCheckOpts): Promise<void> {
  const startTs = performance.now()
  const root = process.cwd()
  const rulesDir = opts.rulesDir ?? (
    await exists(path.join(root, 'sentinel-core/invariants'))
      ? path.join(root, 'sentinel-core/invariants')
      : path.join(root, 'invariants')
  )
  const factsDir = opts.factsDir ?? path.join(root, '.codegraph/facts')
  const baselinePath = opts.baseline ?? path.join(root, '.codegraph/violations-baseline.json')
  const timeoutMs = parseInt(String(opts.timeout ?? '5000'), 10)

  const runFromDirs = await loadDatalogRunner()
  const violations = await runRulesWithTimeout(runFromDirs, rulesDir, factsDir, timeoutMs, opts)

  if (opts.updateBaseline) {
    await writeBaseline(baselinePath, violations, opts.json)
    return
  }

  const { newViolations, baselineCount } = opts.diff
    ? await filterAgainstBaseline(violations, baselinePath)
    : { newViolations: violations, baselineCount: 0 }

  emitDatalogCheckOutput({
    opts, violations, newViolations, baselineCount,
    elapsed: Math.round(performance.now() - startTs),
  })
}

/** Dynamically charge `@liby-tools/datalog` runFromDirs runner. */
async function loadDatalogRunner(): Promise<(args: {
  rulesDir: string
  factsDir: string
  allowRecursion?: boolean
}) => Promise<{ outputs: Map<string, ViolationTuple[]> }>> {
  try {
    const datalog = await import('@liby-tools/datalog')
    return datalog.runFromDirs as any
  } catch {
    console.error(chalk.red(`✗ @liby-tools/datalog not installed`))
    process.exit(1)
  }
}

/**
 * Race l'exécution Datalog contre un timeout dur. Si timeout dépassé,
 * skip silencieux (exit 0) — pattern hook : on préfère manquer une
 * vérification que bloquer le user.
 */
async function runRulesWithTimeout(
  runFromDirs: Awaited<ReturnType<typeof loadDatalogRunner>>,
  rulesDir: string,
  factsDir: string,
  timeoutMs: number,
  opts: DatalogCheckOpts,
): Promise<ViolationTuple[]> {
  const evalPromise = runFromDirs({
    rulesDir, factsDir, allowRecursion: true,
  }).catch((err: unknown) => ({ error: err }))
  const timeoutPromise = new Promise<{ timeout: true }>((resolve) =>
    setTimeout(() => resolve({ timeout: true }), timeoutMs),
  )
  const raced = await Promise.race([evalPromise, timeoutPromise])

  if ('timeout' in raced) {
    if (opts.json) console.log(JSON.stringify({ timeout: true, ms: timeoutMs }))
    else console.error(chalk.yellow(`⚠ datalog-check timeout (${timeoutMs}ms) — skipped`))
    process.exit(0)
  }
  if ('error' in raced) {
    if (opts.json) console.log(JSON.stringify({ error: String((raced as any).error) }))
    else console.error(chalk.red(`✗ datalog-check failed: ${(raced as any).error}`))
    process.exit(1)
  }

  const result = raced as { outputs: Map<string, ViolationTuple[]> }
  return result.outputs.get('Violation') ?? []
}

/** Stable key per violation tuple — pour set-based diff. */
const keyOfViolation = (v: ViolationTuple): string =>
  `${v[0]}\x00${v[1]}\x00${v[2]}\x00${v[3]}`

async function writeBaseline(
  baselinePath: string,
  violations: ViolationTuple[],
  json: boolean | undefined,
): Promise<void> {
  const fsPromises = await import('node:fs/promises')
  await fsPromises.writeFile(
    baselinePath,
    JSON.stringify({
      violations,
      updatedAt: new Date().toISOString(),
    }, null, 2) + '\n',
  )
  if (json) {
    console.log(JSON.stringify({ updated: true, count: violations.length }))
  } else {
    console.log(chalk.green(`✓ baseline updated (${violations.length} violations) → ${baselinePath}`))
  }
}

async function filterAgainstBaseline(
  violations: ViolationTuple[],
  baselinePath: string,
): Promise<{ newViolations: ViolationTuple[]; baselineCount: number }> {
  try {
    const fsPromises = await import('node:fs/promises')
    const raw = await fsPromises.readFile(baselinePath, 'utf-8')
    const baseline = JSON.parse(raw)
    const baselineKeys = new Set(
      (baseline.violations ?? []).map((v: ViolationTuple) => keyOfViolation(v)),
    )
    return {
      baselineCount: baselineKeys.size,
      newViolations: violations.filter((v) => !baselineKeys.has(keyOfViolation(v))),
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err
    // No baseline = treat as empty baseline → tout = nouveau.
    return { newViolations: violations, baselineCount: 0 }
  }
}

function emitDatalogCheckOutput(args: {
  opts: DatalogCheckOpts
  violations: ViolationTuple[]
  newViolations: ViolationTuple[]
  baselineCount: number
  elapsed: number
}): void {
  const { opts, violations, newViolations, baselineCount, elapsed } = args

  if (opts.json) {
    console.log(JSON.stringify({
      elapsed,
      total: violations.length,
      baseline: baselineCount,
      new: newViolations.length,
      violations: newViolations.map(([adr, file, line, msg]) => ({ adr, file, line, msg })),
    }))
    return
  }

  if (newViolations.length === 0) {
    if (opts.diff) {
      console.log(chalk.green(
        `  ✓ no NEW violations (baseline=${baselineCount}, current=${violations.length}, ${elapsed}ms)`,
      ))
    } else {
      console.log(chalk.green(`  ✓ ${violations.length} violations (all grandfathered, ${elapsed}ms)`))
    }
    return
  }

  const header = opts.diff
    ? chalk.red(`  ✗ ${newViolations.length} NEW violation(s) introduced since baseline (${elapsed}ms)`)
    : chalk.red(`  ✗ ${newViolations.length} violation(s) (${elapsed}ms)`)
  console.log(header)
  for (const [adr, file, line, msg] of newViolations.slice(0, 20)) {
    const lineStr = line === 0 ? '' : `:${line}`
    console.log(`    ${chalk.bold(adr)} ${file}${lineStr}`)
    console.log(`      ${msg}`)
  }
  if (newViolations.length > 20) {
    console.log(chalk.dim(`    +${newViolations.length - 20} more`))
  }
  process.exit(opts.diff ? 0 : 1) // diff mode = info, no fail
}
