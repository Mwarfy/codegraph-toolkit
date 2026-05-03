#!/usr/bin/env node
/**
 * liby-runtime-graph CLI
 *
 * Phase α — sous-commandes :
 *   run     : lance un run complet (driver + capture + facts export + rules)
 *   facts   : capture seulement (pas de rules)
 *   check   : run rules sur facts existants (pas de capture)
 *
 * Usage typique sur un projet observé :
 *
 *   # 1. Codegraph statique d'abord (génère .codegraph/facts/)
 *   $ npx codegraph analyze
 *
 *   # 2. App tournant en localhost:3000 avec OTel SDK attach (host process)
 *   #    OU lancer dans un sub-process avec `--require <bootstrap>`
 *
 *   # 3. Run runtime-graph
 *   $ npx liby-runtime-graph run --duration 300
 *
 *   # 4. Lire le rapport
 *   $ cat .codegraph/facts-runtime/report.md
 */

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { Command } from 'commander'
import chalk from 'chalk'
import { syntheticDriver } from './drivers/synthetic.js'
import { replayTestsDriver } from './drivers/replay-tests.js'
import { chaosDriver } from './drivers/chaos.js'
import { exportFactsRuntime } from './facts/exporter.js'
import { attachRuntimeCapture } from './capture/otel-attach.js'
import { aggregateSpans } from './capture/span-aggregator.js'
import type { RuntimeSnapshot } from './core/types.js'

const program = new Command()

program
  .name('liby-runtime-graph')
  .description('Runtime observability framework — captures actual execution graph, joins with codegraph statique via datalog')
  .version('0.1.0-alpha.2')

program
  .command('run')
  .description('Capture runtime via synthetic driver + export facts + run datalog rules')
  .option('--driver <name>', 'driver name (synthetic|replay-tests|chaos)', 'synthetic')
  .option('--replay-cmd <cmd>', '[replay-tests] command to spawn (default: npm)', 'npm')
  .option('--replay-args <args...>', '[replay-tests] command args (default: ["test"])')
  .option('--duration <seconds>', 'capture duration in seconds', '300')
  .option('--project-root <path>', 'project root path', process.cwd())
  .option('--out-dir <path>', 'output dir for runtime facts', '')
  .option('--base-url <url>', '[synthetic] target app baseUrl', 'http://localhost:3000')
  .option('--no-rules', 'skip datalog rules execution (capture only)')
  .action(async (opts) => {
    const projectRoot = path.resolve(opts.projectRoot)
    const outDir = opts.outDir
      ? path.resolve(opts.outDir)
      : path.join(projectRoot, '.codegraph/facts-runtime')
    const durationSec = parseInt(opts.duration, 10)
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      console.error(chalk.red(`Invalid --duration: ${opts.duration}`))
      process.exit(2)
    }

    console.log(chalk.bold(`▶ liby-runtime-graph run`))
    console.log(chalk.gray(`  driver=${opts.driver}  duration=${durationSec}s  out=${path.relative(projectRoot, outDir)}`))

    // 1. Attach OTel capture
    const capture = attachRuntimeCapture({
      projectRoot,
      excludePaths: ['/health', '/metrics', '/favicon.ico'],
    })
    console.log(chalk.gray(`  ✓ OTel capture attached`))

    // 2. Run driver
    const startedAtUnix = Math.floor(Date.now() / 1000)
    const startTime = Date.now()
    let driverResult

    if (opts.driver === 'synthetic') {
      driverResult = await syntheticDriver.run({
        projectRoot,
        durationMs: durationSec * 1000,
        config: { baseUrl: opts.baseUrl },
      })
    } else if (opts.driver === 'replay-tests') {
      // Le driver replay-tests spawn un sub-process avec OTel pre-attached.
      // Les spans du sub-process sont écrits dans un tmpDir séparé (via
      // auto-bootstrap.ts), exposé au caller via DriverRunResult.bootstrapFactsDir.
      // Le CLI merge ce tmpDir dans outDir après le driver.
      driverResult = await replayTestsDriver.run({
        projectRoot,
        durationMs: durationSec * 1000,
        config: {
          command: opts.replayCmd,
          args: opts.replayArgs,
        },
      })
    } else if (opts.driver === 'chaos') {
      // Chaos driver : error injection sur les routes HTTP statique-discoverées.
      // Force l'exécution des error paths que synthetic ne touche pas.
      driverResult = await chaosDriver.run({
        projectRoot,
        durationMs: durationSec * 1000,
        config: { baseUrl: opts.baseUrl },
      })
    } else {
      console.error(chalk.red(`Unknown driver: ${opts.driver}. Phase β supports: synthetic, replay-tests, chaos`))
      process.exit(2)
      return
    }
    const elapsedMs = Date.now() - startTime
    console.log(chalk.gray(`  ✓ ${opts.driver} driver: ${driverResult.actionsCount} actions in ${(elapsedMs / 1000).toFixed(1)}s`))
    if (driverResult.warnings.length > 0) {
      console.log(chalk.yellow(`  ⚠ ${driverResult.warnings.length} driver warnings:`))
      for (const w of driverResult.warnings.slice(0, 5)) {
        console.log(chalk.yellow(`    - ${w}`))
      }
    }

    // 3. Stop capture, get spans, aggregate
    const spans = await capture.stop()
    console.log(chalk.gray(`  ✓ Captured ${spans.length} spans (in-process)`))

    const snapshot: RuntimeSnapshot = aggregateSpans(spans, {
      projectRoot,
      runMeta: {
        driver: opts.driver,
        startedAtUnix,
        durationMs: elapsedMs,
        totalSpans: spans.length,
      },
    })

    // 4. Export in-process facts
    const exportResult = await exportFactsRuntime(snapshot, { outDir })

    // 4b. Merge bootstrap facts (sub-process replay-tests case).
    // Si le driver a écrit ses propres facts dans un tmpDir (via
    // auto-bootstrap.ts), on les merge en CONCATENANT lex sorted —
    // l'in-process snapshot et le sub-process bootstrap se complètent
    // (in-process : driver overhead + manual spans ; sub-process :
    // toute la couverture de la suite de tests).
    if (driverResult.bootstrapFactsDir) {
      try {
        await mergeFactsDirs(driverResult.bootstrapFactsDir, outDir)
        await fs.rm(driverResult.bootstrapFactsDir, { recursive: true, force: true })
      } catch (err) {
        console.log(chalk.yellow(`  ⚠ bootstrap facts merge failed: ${err instanceof Error ? err.message : err}`))
      }
    }
    console.log(chalk.gray(`  ✓ Wrote ${exportResult.relations.length} relations`))
    for (const rel of exportResult.relations) {
      console.log(chalk.gray(`    ${rel.name.padEnd(28)} ${String(rel.tuples).padStart(5)} tuples`))
    }

    // 5. Generate RuntimeRouteExpected.facts (parsed from EntryPoint.facts)
    await generateRuntimeRouteExpected(projectRoot, outDir)

    // 6. Ensure RuntimeRuleExempt.facts exists (empty if no project exemptions)
    //    Datalog runner requires every .input relation to have a file (or empty file).
    await ensureRuntimeRuleExempt(projectRoot, outDir)

    // 6. Run datalog rules (unless --no-rules)
    if (opts.rules !== false) {
      await runRulesAndPrint(projectRoot, outDir)
    } else {
      console.log(chalk.gray(`  → datalog rules skipped (--no-rules)`))
    }

    console.log(chalk.bold(`\n✓ Run complete. Facts in ${path.relative(projectRoot, outDir)}`))
  })

program
  .command('check')
  .description('Run datalog rules on existing runtime facts (no capture)')
  .option('--project-root <path>', 'project root path', process.cwd())
  .option('--facts-dir <path>', 'facts-runtime dir', '')
  .action(async (opts) => {
    const projectRoot = path.resolve(opts.projectRoot)
    const factsDir = opts.factsDir
      ? path.resolve(opts.factsDir)
      : path.join(projectRoot, '.codegraph/facts-runtime')
    await runRulesAndPrint(projectRoot, factsDir)
  })

program.parseAsync(process.argv).catch(err => {
  console.error(chalk.red('liby-runtime-graph fatal:'), err)
  process.exit(1)
})

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Merge deux dirs de facts TSV : pour chaque .facts du srcDir, on append
 * les lignes au .facts correspondant de dstDir, on dédoublonne, on
 * resort lex. Conserve la determinism du format codegraph.
 *
 * RuntimeRunMeta est OVERWRITE (un seul run = 1 row) — sinon on aurait
 * 2 rows et les rules qui le consomment se confuseraient.
 *
 * Le bootstrap (replay-tests) écrit dans des sub-dirs `pid-<N>/` pour
 * éviter les collisions parent/child. Cette fonction explore les sub-dirs
 * et merge le contenu de tous les pid-* dans dstDir.
 */
async function mergeFactsDirs(srcDir: string, dstDir: string): Promise<void> {
  const entries = await fs.readdir(srcDir, { withFileTypes: true })
  // Sources : sub-dirs pid-* + le srcDir lui-même (cas legacy ou direct write)
  const sourceDirs: string[] = [srcDir]
  for (const e of entries) {
    if (e.isDirectory() && e.name.startsWith('pid-')) {
      sourceDirs.push(path.join(srcDir, e.name))
    }
  }

  for (const sd of sourceDirs) {
    let files: string[]
    try { files = await fs.readdir(sd) } catch { continue }

    for (const f of files) {
      if (!f.endsWith('.facts')) continue
      const srcPath = path.join(sd, f)
      // skip if not a regular file (could be sub-dir with same suffix — unlikely)
      try {
        const stat = await fs.stat(srcPath)
        if (!stat.isFile()) continue
      } catch { continue }

      const dstPath = path.join(dstDir, f)
      const srcContent = await fs.readFile(srcPath, 'utf-8')

      if (f === 'RuntimeRunMeta.facts') {
        // Overwrite sur 1ère meta non-vide, ignore subsequent (peuvent venir
        // de plusieurs PIDs — on garde la 1ère pour réduire à 1 row).
        if (srcContent.trim().length > 0) {
          await fs.writeFile(dstPath, srcContent, 'utf-8')
        }
        continue
      }

      let dstContent = ''
      try { dstContent = await fs.readFile(dstPath, 'utf-8') } catch { /* dst absent */ }

      const merged = new Set<string>()
      for (const l of dstContent.split('\n')) if (l.trim()) merged.add(l)
      for (const l of srcContent.split('\n')) if (l.trim()) merged.add(l)

      const sorted = [...merged].sort()
      await fs.writeFile(dstPath, sorted.length > 0 ? sorted.join('\n') + '\n' : '', 'utf-8')
    }
  }
}

/**
 * Crée un RuntimeRuleExempt.facts vide si l'utilisateur n'a pas
 * fourni le sien dans son projet. Datalog .input requiert un fichier.
 *
 * Si le projet a `<projectRoot>/runtime-rule-exempt.facts`, on le copie.
 * Sinon, on écrit un fichier vide.
 */
async function ensureRuntimeRuleExempt(projectRoot: string, outDir: string): Promise<void> {
  const userExemptions = path.join(projectRoot, 'runtime-rule-exempt.facts')
  const dst = path.join(outDir, 'RuntimeRuleExempt.facts')
  try {
    const content = await fs.readFile(userExemptions, 'utf-8')
    await fs.writeFile(dst, content, 'utf-8')
  } catch {
    // Pas d'exemptions utilisateur → fichier vide
    await fs.writeFile(dst, '', 'utf-8')
  }
}

/**
 * Génère RuntimeRouteExpected.facts depuis EntryPoint.facts (statique).
 * Parse les "GET /api/orders" en tuples (method, path) que la rule
 * DEAD_ROUTE peut consommer directement.
 */
async function generateRuntimeRouteExpected(projectRoot: string, outDir: string): Promise<void> {
  const staticFacts = path.join(projectRoot, '.codegraph/facts/EntryPoint.facts')
  let content: string
  try {
    content = await fs.readFile(staticFacts, 'utf-8')
  } catch {
    return                                                              // pas de facts statiques → skip silencieusement
  }
  const lines = content.split('\n').filter(l => l.trim().length > 0)
  const routes: Array<[string, string]> = []
  for (const line of lines) {
    const [, kind, id] = line.split('\t')
    if (kind !== 'http-route') continue
    const m = id.match(/^([A-Z]+)\s+(\/.*)$/)
    if (m) routes.push([m[1], m[2]])
    else if (id.startsWith('/')) routes.push(['GET', id])
  }
  const tsv = routes
    .map(([m, p]) => `${m}\t${p}`)
    .sort()
    .join('\n')
  await fs.writeFile(
    path.join(outDir, 'RuntimeRouteExpected.facts'),
    tsv.length > 0 ? tsv + '\n' : '',
    'utf-8',
  )
}

/**
 * Run datalog rules + pretty print violations.
 * Reuse @liby-tools/datalog runner — pattern identique au test
 * Sentinel datalog-invariants.test.ts.
 */
async function runRulesAndPrint(projectRoot: string, factsDir: string): Promise<void> {
  let datalog: typeof import('@liby-tools/datalog')
  try {
    datalog = await import('@liby-tools/datalog')
  } catch (err) {
    console.error(chalk.red(`@liby-tools/datalog not resolvable: ${err instanceof Error ? err.message : err}`))
    process.exit(2)
  }

  // Le rules dir vit dans le package : <packageRoot>/rules/.
  // Le compiled cli.js est à <packageRoot>/dist/cli.js — donc rules
  // est ../rules relatif au CLI courant. Approche robuste qui marche
  // sans dépendre des exports du package.json.
  const { fileURLToPath } = await import('node:url')
  const __filename = fileURLToPath(import.meta.url)
  const cliDir = path.dirname(__filename)
  const rulesDir = path.resolve(cliDir, '../rules')

  // Ajouter le facts statique dir aussi — les rules joignent statique × runtime.
  const staticFactsDir = path.join(projectRoot, '.codegraph/facts')

  // Combiner les facts dirs : runtime-graph rules ont besoin des deux.
  // Le datalog runner accepte un seul factsDir — on copie temporairement
  // le contenu de staticFactsDir vers factsDir pour le run.
  // (Phase β : étendre datalog.runFromDirs pour multi-factsDir.)
  const combinedFacts = await mergeFactsForRun(factsDir, staticFactsDir)

  try {
    const { result } = await datalog.runFromDirs({
      rulesDir,
      factsDir: combinedFacts,
      recordProofsFor: ['RuntimeAlert'],
      allowRecursion: false,
    })

    const alerts = result.outputs.get('RuntimeAlert') ?? []
    printAlerts(alerts)
  } catch (err) {
    console.error(chalk.red(`datalog run failed: ${err instanceof Error ? err.message : err}`))
    process.exit(1)
  }
}

async function mergeFactsForRun(runtimeDir: string, staticDir: string): Promise<string> {
  // Copy static facts into runtime dir if not already there (don't overwrite runtime facts).
  // Phase α : simple — overwrite-strategy = "runtime wins on collision".
  try {
    const staticFiles = await fs.readdir(staticDir)
    for (const f of staticFiles) {
      if (!f.endsWith('.facts')) continue
      const dst = path.join(runtimeDir, f)
      // Only copy if runtime version doesn't exist (don't shadow)
      try { await fs.access(dst); continue } catch { /* fall through */ }
      const src = path.join(staticDir, f)
      await fs.copyFile(src, dst)
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    // No static facts → datalog still works for rules that don't depend on them.
  }
  return runtimeDir
}

function printAlerts(alerts: ReadonlyArray<ReadonlyArray<unknown>>): void {
  console.log()
  if (alerts.length === 0) {
    console.log(chalk.green(`  ✓ No runtime alerts`))
    return
  }

  // Group by category
  const byCategory = new Map<string, Array<{ target: string; detail: string; message: string }>>()
  for (const tuple of alerts) {
    const [category, target, detail, message] = tuple as [string, string, string, string]
    let arr = byCategory.get(category)
    if (!arr) {
      arr = []
      byCategory.set(category, arr)
    }
    arr.push({ target, detail, message })
  }

  console.log(chalk.bold(`  Runtime alerts: ${alerts.length} across ${byCategory.size} categor${byCategory.size === 1 ? 'y' : 'ies'}`))
  console.log()
  for (const [category, items] of byCategory.entries()) {
    console.log(chalk.yellow(chalk.bold(`▼ ${category}`)) + chalk.gray(` (${items.length})`))
    for (const item of items.slice(0, 10)) {
      const target = item.detail ? `${item.target} ${chalk.gray('·')} ${item.detail}` : item.target
      console.log(`  ${chalk.yellow('•')} ${chalk.bold(target.padEnd(50))} ${chalk.gray(item.message)}`)
    }
    if (items.length > 10) {
      console.log(chalk.gray(`    ... ${items.length - 10} more`))
    }
    console.log()
  }
}
