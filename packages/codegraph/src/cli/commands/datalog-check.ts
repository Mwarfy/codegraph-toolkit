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
import * as fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSarifReport } from '../../output/sarif.js'

/**
 * Résout le dossier de rules invariants par défaut. Ordre :
 *   1. `<root>/sentinel-core/invariants/`           (legacy Sentinel)
 *   2. `<root>/invariants/`                          (in-repo classique)
 *   3. `<root>/.codegraph/invariants/`               (custom user, parallèle au cross-cut)
 *   4. `<root>/node_modules/@liby-tools/invariants-postgres-ts/invariants/` (canonical npm)
 *
 * Sans ce fallback canonical, l'utilisateur qui suit le quickstart
 * `npm i @liby-tools/codegraph @liby-tools/invariants-postgres-ts` se prend un
 * `ENOENT: scandir '<root>/invariants'` au premier `npx codegraph datalog-check`.
 * Symétrique de `cross-check` qui auto-resolve `runtime-graph/rules` (cf. F-006 Janus).
 */
async function resolveDefaultRulesDir(root: string): Promise<string> {
  const candidates = [
    path.join(root, 'sentinel-core/invariants'),
    path.join(root, 'invariants'),
    path.join(root, '.codegraph/invariants'),
    path.join(root, 'node_modules/@liby-tools/invariants-postgres-ts/invariants'),
  ]
  for (const candidate of candidates) {
    try {
      // await-ok: short-circuit sur première match (ordre de priorité des candidats)
      const stat = await fs.stat(candidate)
      if (stat.isDirectory()) return candidate
    } catch {
      // candidate absent — try next
    }
  }
  // Aucun trouvé : retourne le path le plus parlant pour l'erreur ENOENT
  // (`<root>/invariants` reste le default historique).
  return candidates[1]
}

/** Lit la version du toolkit depuis package.json (runtime, pour SARIF). */
function getToolkitVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const pkgPath = path.resolve(here, '../../../package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export interface DatalogCheckOpts {
  rulesDir?: string
  factsDir?: string
  baseline?: string
  diff?: boolean
  updateBaseline?: boolean
  json?: boolean
  /** Format de sortie alternatif. `sarif` emet du SARIF 2.1.0 (consommable
   * par GitHub Code Scanning, VS Code SARIF Viewer, etc.). */
  format?: 'sarif'
  /** Alias court de `--format sarif`. Reflexe attendu par les users
   * (cf. F-110 dpl-rag dogfood) — sans cet alias, `--sarif` plante avec
   * `unknown option` sans suggestion. */
  sarif?: boolean
  timeout?: string
}

type ViolationTuple = [string, string, number, string]

export async function runDatalogCheckCommand(opts: DatalogCheckOpts): Promise<void> {
  const startTs = performance.now()
  // Alias `--sarif` → `format: 'sarif'`. Resoud via simple normalisation
  // pour eviter de toucher tous les sites qui lisent `opts.format`.
  if (opts.sarif && !opts.format) opts.format = 'sarif'
  const root = process.cwd()
  const rulesDir = opts.rulesDir ?? await resolveDefaultRulesDir(root)
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
}) => Promise<{ result: { outputs: Map<string, ViolationTuple[]> } }>> {
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

  // `runFromDirs` retourne `{ program, result: { outputs, stats } }` — voir
  // packages/datalog/src/runner.ts. Le shape `{ outputs }` direct n'a jamais
  // existé, c'était une signature périmée qui plantait à la première rule.
  const wrapped = raced as { result: { outputs: Map<string, ViolationTuple[]> } }
  return wrapped.result.outputs.get('Violation') ?? []
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

  if (opts.format === 'sarif') {
    const report = buildSarifReport(
      newViolations.map(([adr, file, line, msg]) => ({ adr, file, line, msg })),
      { toolVersion: getToolkitVersion() },
    )
    console.log(JSON.stringify(report, null, 2))
    return
  }

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
