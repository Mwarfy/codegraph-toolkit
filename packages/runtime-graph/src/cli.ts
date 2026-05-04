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
import { exportDisciplineFacts } from './facts/discipline-exporter.js'
import { attachRuntimeCapture } from './capture/otel-attach.js'
import { aggregateSpans } from './capture/span-aggregator.js'
import { computeAllDisciplines, type StaticCallEdge } from './metrics/runtime-disciplines.js'
import type { RuntimeSnapshot } from './core/types.js'

const program = new Command()

program
  .name('liby-runtime-graph')
  .description('Runtime observability framework — captures actual execution graph, joins with codegraph statique via datalog')
  .version('0.1.0-alpha.3')

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

    // 5b. Phase γ — compute mathematical disciplines from runtime facts
    //     + static SymbolCallEdge for Hamming distance.
    //     Le compute est PURE (pas d'I/O réseau), juste des aggregations
    //     in-memory. Output : 5 nouveaux .facts (HammingStaticRuntime,
    //     IBScoreRuntime, NgGlobalQ, NgFileQ, LyapunovRuntime).
    const staticEdges = await readStaticCallEdges(projectRoot)
    const disciplines = computeAllDisciplines(snapshot, staticEdges)
    const discResult = await exportDisciplineFacts(disciplines, outDir)
    console.log(chalk.gray(`  ✓ Phase γ disciplines computed (${discResult.relations.length} relations)`))
    for (const rel of discResult.relations) {
      console.log(chalk.gray(`    ${rel.name.padEnd(28)} ${String(rel.tuples).padStart(5)} tuples`))
    }

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

// ─── probe : press-button capture pour n'importe quelle app TS ─────────────
//
// Auto-détecte CJS/ESM via package.json `type`, choisit --import ou --require,
// configure les env vars, lance la commande user sous bootstrap. Produit
// les facts runtime + (optionnel) datalog rules + divergence analysis.
//
// Usage typique :
//   npx liby-runtime-graph probe -- npm test
//   npx liby-runtime-graph probe --cpu-profile -- node app.mjs
//   npx liby-runtime-graph probe --fn-wrap -- npx tsx scripts/foo.ts
program
  .command('probe')
  .description('Auto-configure runtime capture + lance la commande user (press-button)')
  .argument('<userCmd...>', 'commande à lancer sous bootstrap (utilise -- pour passer des flags)')
  .option('--project-root <path>', 'project root', process.cwd())
  .option('--out-dir <path>', 'facts output dir', '')
  .option('--cpu-profile', 'enable V8 CPU profile capture')
  .option('--fn-wrap', 'enable iitm function wrapping (exact call edges, dev-only)')
  .option('--no-divergence', 'skip post-run divergence analysis')
  .allowUnknownOption()  // pour passer flags arbitraires à la cmd user via `--`
  .action(async (userCommand: string[], opts) => {
    const projectRoot = path.resolve(opts.projectRoot)
    if (userCommand.length === 0) {
      console.error(chalk.red('  ✗ Provide a command after `--`. Example : probe -- npm test'))
      process.exit(1)
    }

    const outDir = opts.outDir
      ? path.resolve(opts.outDir)
      : path.join(projectRoot, '.codegraph/facts-runtime-bootstrap')

    // Auto-détecte CJS vs ESM via package.json
    const pkgType = await detectPackageType(projectRoot)
    const bootstrapPath = await resolveBootstrapAbsolutePath(projectRoot)
    if (!bootstrapPath) {
      console.error(chalk.red('  ✗ Cannot find @liby-tools/runtime-graph bootstrap. Install it.'))
      process.exit(1)
    }

    const flag = pkgType === 'module' ? `--import file://${bootstrapPath}` : `--require ${bootstrapPath}`
    console.log(chalk.cyan(`  ⓘ detected package type: ${pkgType} → using ${flag.split(' ')[0]}`))

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} ${flag}`.trim(),
      LIBY_RUNTIME_PROJECT_ROOT: projectRoot,
      LIBY_RUNTIME_FACTS_OUT: outDir,
    }
    if (opts.cpuProfile) env.LIBY_RUNTIME_CPU_PROFILE = '1'
    if (opts.fnWrap) env.LIBY_RUNTIME_FN_WRAP = '1'

    console.log(chalk.cyan(`  ⓘ running: ${userCommand.join(' ')}`))
    const t0 = Date.now()

    const { spawn } = await import('node:child_process')
    const exitCode = await new Promise<number>((resolve) => {
      const child = spawn(userCommand[0], userCommand.slice(1), {
        cwd: projectRoot,
        env,
        stdio: 'inherit',
      })
      child.on('exit', (code) => resolve(code ?? 0))
    })

    const elapsedMs = Date.now() - t0
    console.log(chalk.gray(`  ⓘ command finished in ${(elapsedMs / 1000).toFixed(1)}s with exit ${exitCode}`))

    // Compute totals across pid-* subdirs (auto-bootstrap writes per-PID).
    const totals = await summarizeProbeOutput(outDir)
    console.log(chalk.green(`  ✓ ${totals.totalSpans} spans captured across ${totals.subDirs} sub-process(es) → ${path.relative(projectRoot, outDir)}`))

    if (opts.divergence !== false) {
      try {
        const divModule = await import('./optim/divergence.js')
        const staticDir = path.join(projectRoot, '.codegraph/facts')
        const result = await loadAndAnalyzeDivergence(staticDir, outDir, divModule.analyzeDivergence)
        if (result) {
          console.log()
          console.log(divModule.renderDivergenceMarkdown(result as Parameters<typeof divModule.renderDivergenceMarkdown>[0]))
        }
      } catch (err) {
        console.log(chalk.gray(`  ⓘ divergence analysis skipped: ${err instanceof Error ? err.message : err}`))
      }
    }

    process.exit(exitCode)
  })

/**
 * Résout le path absolu vers `auto-bootstrap.js` du package runtime-graph.
 * Cherche dans plusieurs layers (project node_modules, workspace root,
 * fallback path relatif depuis ce CLI). Retourne null si introuvable.
 */
async function resolveBootstrapAbsolutePath(projectRoot: string): Promise<string | null> {
  const candidates = [
    path.join(projectRoot, 'node_modules/@liby-tools/runtime-graph/dist/capture/auto-bootstrap.js'),
    path.join(projectRoot, '../node_modules/@liby-tools/runtime-graph/dist/capture/auto-bootstrap.js'),
    // Fallback : depuis ce module compilé, on connaît le chemin relatif
    path.resolve(path.dirname(new URL(import.meta.url).pathname), './capture/auto-bootstrap.js'),
  ]
  for (const c of candidates) {
    try {
      await fs.access(c)
      return c
    } catch {
      continue
    }
  }
  return null
}

/**
 * Walk les sub-dirs pid-* dans outDir, somme totalSpans depuis chaque
 * RuntimeRunMeta.facts. Sert au reporting du probe — pas de merge fichiers,
 * juste un compte rapide.
 */
async function summarizeProbeOutput(outDir: string): Promise<{ totalSpans: number; subDirs: number }> {
  let totalSpans = 0
  let subDirs = 0
  try {
    const entries = await fs.readdir(outDir, { withFileTypes: true })
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.startsWith('pid-')) continue
      subDirs++
      const metaPath = path.join(outDir, e.name, 'RuntimeRunMeta.facts')
      try {
        const text = await fs.readFile(metaPath, 'utf-8')
        const cols = text.trim().split('\n')[0]?.split('\t') ?? []
        const spans = parseInt(cols[3] ?? '0', 10)
        if (Number.isFinite(spans)) totalSpans += spans
      } catch {
        // missing meta — skip
      }
    }
  } catch {
    // outDir doesn't exist — return zeros
  }
  return { totalSpans, subDirs }
}

async function detectPackageType(projectRoot: string): Promise<'module' | 'commonjs'> {
  try {
    const pkgPath = path.join(projectRoot, 'package.json')
    const raw = await fs.readFile(pkgPath, 'utf-8')
    const pkg = JSON.parse(raw)
    return pkg.type === 'module' ? 'module' : 'commonjs'
  } catch {
    return 'commonjs'  // safest default
  }
}

async function loadAndAnalyzeDivergence(
  staticDir: string,
  runtimeDir: string,
  analyzeDivergence: (opts: {
    staticEdges: Array<{ fromFile: string; fromFn: string; toFile: string; toFn: string; count: number }>
    runtimeEdges: Array<{ fromFile: string; fromFn: string; toFile: string; toFn: string; count: number }>
    runtimeSymbols: Array<{ file: string; fn: string; count: number }>
    topN?: number
  }) => unknown,
): Promise<unknown | null> {
  const staticFile = path.join(staticDir, 'SymbolCallEdge.facts')
  const runtimeEdgesFile = path.join(runtimeDir, 'CallEdgeRuntime.facts')
  const runtimeSymbolsFile = path.join(runtimeDir, 'SymbolTouchedRuntime.facts')

  const staticText = await fs.readFile(staticFile, 'utf-8').catch(() => '')
  const runtimeEdgesText = await fs.readFile(runtimeEdgesFile, 'utf-8').catch(() => '')
  const runtimeSymbolsText = await fs.readFile(runtimeSymbolsFile, 'utf-8').catch(() => '')

  if (!staticText.trim() || !runtimeEdgesText.trim()) return null

  const staticEdges = staticText.trim().split('\n').map((l) => {
    const c = l.split('\t')
    return { fromFile: c[0], fromFn: c[1], toFile: c[2], toFn: c[3], count: 1 }
  })
  const runtimeEdges = runtimeEdgesText.trim().split('\n').map((l) => {
    const c = l.split('\t')
    return {
      fromFile: c[0], fromFn: c[1], toFile: c[2], toFn: c[3],
      count: parseInt(c[4], 10),
    }
  })
  const runtimeSymbols = runtimeSymbolsText.trim().split('\n').filter(Boolean).map((l) => {
    const c = l.split('\t')
    return { file: c[0], fn: c[1], count: parseInt(c[2], 10) }
  })

  return analyzeDivergence({ staticEdges, runtimeEdges, runtimeSymbols, topN: 5 })
}

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

// Guard auto-run : ne déclenche `parseAsync` QUE si ce fichier est invoqué
// comme entry point (via `node cli.js` ou `liby-runtime-graph` bin).
// Permet aux tests d'importer le module pour vérifier les commands
// enregistrées sans démarrer le CLI.
async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false
  const { fileURLToPath } = await import('node:url')
  const { realpathSync } = await import('node:fs')
  try {
    const here = realpathSync(fileURLToPath(import.meta.url))
    const argv1 = realpathSync(process.argv[1])
    return here === argv1
  } catch {
    return false
  }
}

if (await isMainModule()) {
  program.parseAsync(process.argv).catch((err) => {
    console.error(chalk.red('liby-runtime-graph fatal:'), err)
    process.exit(1)
  })
}

export { program }

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
  const sourceDirs = await listSourceDirs(srcDir)
  // CLI one-shot fact merge — séquentiel acceptable (<100ms total).
  // Promise.all sur la double boucle nested rendrait le code dur à lire pour
  // gain négligeable côté CLI tool.
  for (const sd of sourceDirs) {
    await mergeOneSourceDir(sd, dstDir)
  }
}

/** Sources : sub-dirs pid-* + le srcDir lui-même (cas legacy ou direct write). */
async function listSourceDirs(srcDir: string): Promise<string[]> {
  const entries = await fs.readdir(srcDir, { withFileTypes: true })
  const sourceDirs: string[] = [srcDir]
  for (const e of entries) {
    if (e.isDirectory() && e.name.startsWith('pid-')) {
      sourceDirs.push(path.join(srcDir, e.name))
    }
  }
  return sourceDirs
}

async function mergeOneSourceDir(sd: string, dstDir: string): Promise<void> {
  let files: string[]
  // await-ok: CLI fact-merge one-shot, séquentiel délibéré
  try { files = await fs.readdir(sd) } catch { return }

  for (const f of files) {
    if (!f.endsWith('.facts')) continue
    const srcPath = path.join(sd, f)
    if (!(await isRegularFile(srcPath))) continue
    await mergeOneFactsFile(srcPath, path.join(dstDir, f), f)
  }
}

async function isRegularFile(p: string): Promise<boolean> {
  try {
    // await-ok: CLI fact-merge one-shot, séquentiel délibéré
    const stat = await fs.stat(p)
    return stat.isFile()
  } catch {
    return false
  }
}

/**
 * Merge `srcPath` content into `dstPath` :
 *   - RuntimeRunMeta.facts : overwrite (premier non-vide gagne, ignore subsequent
 *     pour réduire à 1 row même avec plusieurs PIDs).
 *   - autres .facts : union dédupliquée + sort lex.
 */
async function mergeOneFactsFile(srcPath: string, dstPath: string, filename: string): Promise<void> {
  // await-ok: CLI fact-merge one-shot, séquentiel délibéré
  const srcContent = await fs.readFile(srcPath, 'utf-8')

  if (filename === 'RuntimeRunMeta.facts') {
    if (srcContent.trim().length > 0) {
      await fs.writeFile(dstPath, srcContent, 'utf-8')
    }
    return
  }

  let dstContent = ''
  // await-ok: CLI fact-merge one-shot, séquentiel délibéré
  try { dstContent = await fs.readFile(dstPath, 'utf-8') } catch { /* dst absent */ }

  const merged = new Set<string>()
  for (const l of dstContent.split('\n')) if (l.trim()) merged.add(l)
  for (const l of srcContent.split('\n')) if (l.trim()) merged.add(l)

  const sorted = [...merged].sort()
  await fs.writeFile(dstPath, sorted.length > 0 ? sorted.join('\n') + '\n' : '', 'utf-8')
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
 * Lit SymbolCallEdge.facts statique → array StaticCallEdge.
 * Utilisé par computeAllDisciplines pour calculer la distance de Hamming
 * statique↔runtime. Retourne [] si .codegraph/facts absent (Phase γ
 * tolérant — Hamming juste skip si pas de facts statiques).
 */
async function readStaticCallEdges(projectRoot: string): Promise<StaticCallEdge[]> {
  const file = path.join(projectRoot, '.codegraph/facts/SymbolCallEdge.facts')
  try {
    const content = await fs.readFile(file, 'utf-8')
    return content
      .split('\n')
      .filter(l => l.trim().length > 0)
      .map(line => {
        const cols = line.split('\t')
        // Schema : (fromFile, fromSymbol, toFile, toSymbol, line)
        return {
          fromFile: cols[0] ?? '',
          fromFn: cols[1] ?? '',
          toFile: cols[2] ?? '',
          toFn: cols[3] ?? '',
        }
      })
      .filter(e => e.fromFile && e.fromFn && e.toFile && e.toFn)
  } catch {
    return []
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
    // Copy facts statiques en parallèle (fichiers indépendants, no collision).
    await Promise.all(
      staticFiles
        .filter((f) => f.endsWith('.facts'))
        .map(async (f) => {
          const dst = path.join(runtimeDir, f)
          // Only copy if runtime version doesn't exist (don't shadow)
          try {
            await fs.access(dst)
            return // déjà présent côté runtime — skip
          } catch { /* fall through to copy */ }
          const src = path.join(staticDir, f)
          await fs.copyFile(src, dst)
        }),
    )
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
