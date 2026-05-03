// ADR-008
/**
 * CodeGraph Analyzer
 *
 * Orchestrates the full analysis pipeline:
 * 1. Discover files via glob patterns
 * 2. Build file cache for detectors
 * 3. Run each detector
 * 4. Feed edges into the graph engine
 * 5. Compute orphan status
 * 6. Generate snapshot
 *
 * Designed to be called from the CLI or programmatically.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { minimatch } from 'minimatch'
import { CodeGraph } from './graph.js'
import { discoverFiles } from './file-discovery.js'
import type {
  CodeGraphConfig,
  DetectorContext,
  DetectedLink,
  GraphSnapshot,
} from './types.js'
import { createDetectors } from '../detectors/index.js'
import { createSharedProject } from '../extractors/unused-exports.js'
import { DetectorRegistry, type DetectorRunContext } from './detector-registry.js'
import { OauthScopeLiteralsDetector } from './detectors/oauth-scope-literals-detector.js'
import { EventEmitSitesDetector } from './detectors/event-emit-sites-detector.js'
import { EnvUsageDetector } from './detectors/env-usage-detector.js'
import { PackageDepsDetector } from './detectors/package-deps-detector.js'
import { BarrelsDetector } from './detectors/barrels-detector.js'
import { UnusedExportsDetector } from './detectors/unused-exports-detector.js'
import { ComplexityDetector } from './detectors/complexity-detector.js'
import { SymbolRefsDetector } from './detectors/symbol-refs-detector.js'
import { TypedCallsDetector } from './detectors/typed-calls-detector.js'
import { CyclesDetector } from './detectors/cycles-detector.js'
import { TruthPointsDetector } from './detectors/truth-points-detector.js'
import { DataFlowsDetector } from './detectors/data-flows-detector.js'
import { StateMachinesDetector } from './detectors/state-machines-detector.js'
import { TaintDetector } from './detectors/taint-detector.js'
import { SqlSchemaDetector } from './detectors/sql-schema-detector.js'
import { DrizzleSchemaDetector } from './detectors/drizzle-schema-detector.js'
import { analyzeTodos, type TodoMarker } from '../extractors/todos.js'
import { analyzeDriftPatterns, type DriftSignal } from '../extractors/drift-patterns.js'
import { analyzeEvalCalls, type EvalCall } from '../extractors/eval-calls.js'
import { analyzeCryptoCalls, type CryptoCall } from '../extractors/crypto-algo.js'
import { analyzeSecurityPatterns, type SecurityPatternsAggregated } from '../extractors/security-patterns.js'
import { analyzeEventListenerSites, type EventListenerSite } from '../extractors/event-listener-sites.js'
import { analyzeCodeQualityPatterns, type CodeQualityPatternsAggregated } from '../extractors/code-quality-patterns.js'
import { analyzeFunctionComplexity, type FunctionComplexity } from '../extractors/function-complexity.js'
import { computeSpectralMetrics, type SpectralMetric } from '../extractors/spectral-graph.js'
import { computeSymbolEntropy, type SymbolEntropyMetric } from '../extractors/symbol-entropy.js'
import { detectSignatureDuplicates, type SignatureDuplicate } from '../extractors/signature-duplication.js'
import { computePersistentCycles, type PersistentCycle } from '../extractors/persistent-cycles.js'
import { computeLyapunovMetrics, type LyapunovMetric } from '../extractors/lyapunov-cochange.js'
import { computePackageMinCuts, type PackageMinCut } from '../extractors/package-mincut.js'
import { computeInformationBottleneck, type InformationBottleneck } from '../extractors/information-bottleneck.js'
import { computeCommunityDetection, type ImportCommunity, type ModularityScore } from '../extractors/community-detection.js'
import { computeFactStability, type FactKindStability } from '../extractors/fact-stability.js'
import { analyzeCompressionSimilarity, type NormalizedCompressionDistance } from '../extractors/compression-similarity.js'
import { computeGrangerCausality, type GrangerCausality } from '../extractors/granger-causality.js'
import { runCrossDisciplineDetectors } from '../extractors/_shared/cross-discipline-orchestrator.js'
import { CrossDisciplineDetector } from './detectors/cross-discipline-detector.js'
import { analyzeHardcodedSecrets, type HardcodedSecret } from '../extractors/hardcoded-secrets.js'
import { analyzeBooleanParams, type BooleanParamSite } from '../extractors/boolean-params.js'
import { analyzeDeadCode, type DeadCodeFinding } from '../extractors/dead-code.js'
import { analyzeFloatingPromises, type FloatingPromiseSite } from '../extractors/floating-promises.js'
import { analyzeDeprecatedUsage, type DeprecatedDeclaration, type DeprecatedUsageSite } from '../extractors/deprecated-usage.js'
import { analyzeArticulationPoints, type ArticulationPoint } from '../extractors/articulation-points.js'
import { extractConstantExpressionsFileBundle, type ConstantExpressionFinding } from '../extractors/constant-expressions.js'
import { importEslintViolations, type EslintViolation } from '../extractors/eslint-import.js'
import { findSqlNamingViolations, type SqlNamingViolation } from '../extractors/sql-naming.js'
import { findMigrationOrderViolations, type MigrationOrderViolation } from '../extractors/sql-migration-order.js'
import { analyzeResourceBalance, type ResourceImbalance } from '../extractors/resource-balance.js'
import { analyzeTaintSinks, type TaintSink } from '../extractors/taint-sinks.js'
import { analyzeSanitizers, type Sanitizer } from '../extractors/sanitizers.js'
import { analyzeTaintedVars, type TaintedVarDecl, type TaintedArgCall } from '../extractors/tainted-vars.js'
import { analyzeArguments, type TaintedArgumentToCall, type FunctionParam } from '../extractors/arguments.js'
import { analyzeLongFunctions, type LongFunction } from '../extractors/long-functions.js'
import { analyzeMagicNumbers, type MagicNumber } from '../extractors/magic-numbers.js'
import { analyzeTestCoverage, type TestCoverageReport } from '../extractors/test-coverage.js'
import { analyzeCoChange, type CoChangePair } from '../extractors/co-change.js'
import {
  fileContent as incFileContent,
  projectFiles as incProjectFiles,
  setIncrementalContext,
  getCachedMtime as incGetCachedMtime,
  setCachedMtime as incSetCachedMtime,
  setInputIfChanged as incSetInputIfChanged,
  getMtimeMap as incGetMtimeMap,
  loadMtimeMap as incLoadMtimeMap,
} from '../incremental/queries.js'
import { getOrBuildSharedProject as incGetOrBuildProject } from '../incremental/project-cache.js'
import {
  loadPersistedCache as incLoadPersistedCache,
  savePersistedCache as incSavePersistedCache,
} from '../incremental/persistence.js'
import { sharedDb as incSharedDb } from '../incremental/database.js'
import {
  allStateMachines as incAllStateMachines,
  sqlDefaultsInput as incSqlDefaults,
} from '../incremental/state-machines.js'
import {
  scanSqlColumnDefaultsForIncremental,
  discoverSqlFilesForIncremental,
  type WriteSignal as StateMachineWriteSignal,
} from '../extractors/state-machines.js'
import { allTsImports as incAllTsImports } from '../incremental/ts-imports.js'
import { allCodeQualityPatterns as incAllCodeQualityPatterns } from '../incremental/code-quality-patterns.js'
import { allSecurityPatterns as incAllSecurityPatterns } from '../incremental/security-patterns.js'
import { allDeadCode as incAllDeadCode } from '../incremental/dead-code.js'
import { allDeprecatedUsage as incAllDeprecatedUsage } from '../incremental/deprecated-usage.js'
import { allConstantExpressions as incAllConstantExpressions } from '../incremental/constant-expressions.js'
import { allDriftPatternsAst as incAllDriftPatternsAst } from '../incremental/drift-patterns.js'
import {
  allCoChangePairs as incAllCoChangePairs,
  coChangeGitHeadInput as incCoChangeGitHead,
  coChangeKnownFilesInput as incCoChangeKnownFiles,
} from '../incremental/co-change.js'
import { todoToDriftSignal } from '../extractors/drift-patterns.js'
import { setTsImportPrebuiltProject } from '../detectors/ts-imports.js'
import {
  allModuleMetrics as incAllModuleMetrics,
  allComponentMetrics as incAllComponentMetrics,
  graphNodesInput as incGraphNodes,
  graphEdgesForMetricsInput as incGraphEdgesForMetrics,
} from '../incremental/metrics.js'
import { packageManifestsInput as incPackageManifests } from '../incremental/queries.js'
import {
  discoverManifests as discoverPackageManifests,
  findClosestManifest as findClosestPackageManifest,
} from '../extractors/package-deps.js'
import { computeModuleMetrics } from '../metrics/module-metrics.js'
import { computeComponentMetrics } from '../metrics/component-metrics.js'
import { computeDsm } from '../graph/dsm.js'
import { aggregateByContainer } from '../map/dsm-renderer.js'
import { execSync } from 'node:child_process'

/**
 * Récupère le SHA HEAD courant. Utilisé comme clé d'invalidation Salsa
 * pour les détecteurs git-driven (co-change). Retourne `''` si le repo
 * n'est pas git ou si git n'est pas installé — Salsa traitera cette
 * "absence" comme une key stable.
 */
function getGitHead(rootDir: string): string {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: rootDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return ''
  }
}

export interface AnalyzeResult {
  snapshot: GraphSnapshot
  timing: {
    total: number
    fileDiscovery: number
    detectors: Record<string, number>
    graphBuild: number
  }
}

export interface AnalyzeOptions {
  /**
   * Mode "facts-only" : ne tourne QUE les extracteurs nécessaires aux .facts
   * Datalog (event-emit-sites, env-usage, oauth-scope-literals, module-metrics
   * + détecteurs de base ts-imports/event-bus/http/bullmq/db-tables pour le
   * graph). Skip unused-exports, complexity, symbol-refs, typed-calls,
   * cycles, truth-points, data-flows, state-machines, package-deps, barrels,
   * taint, component-metrics, dsm.
   *
   * Sentinel : passe de ~14s à ~5s. Utilisé au pre-commit hook pour
   * rafraîchir les facts avant les invariants Datalog.
   */
  factsOnly?: boolean

  /**
   * Mode "incremental" (Sprint 2 — Phase 1 Salsa migration) : route les
   * détecteurs Salsa-isés (env-usage, oauth-scope-literals à ce stade)
   * via le runtime @liby-tools/salsa au lieu du chemin batch. Sur deux runs
   * successifs sans changement, le 2e doit hit le cache (sub-seconde).
   *
   * Les détecteurs non-encore-migrés continuent de tourner en batch
   * (legacy path) — c'est volontaire, Sprint 3 migrera les autres.
   *
   * Compatible avec `factsOnly: true`.
   */
  incremental?: boolean

  /**
   * Skip le load du cache disque au boot. Utilisé par le watcher mode
   * (Sprint 9) qui maintient la DB en RAM entre analyzes — relire le
   * disque chaque fois ajouterait ~500ms de I/O+parse pour rien.
   */
  skipPersistenceLoad?: boolean

  /**
   * Skip le save du cache disque à la fin. Utilisé par le watcher
   * mode pour ne pas écrire 3-7 MB à chaque change. Le caller est
   * responsable de save périodiquement / au stop.
   */
  skipPersistenceSave?: boolean

  /**
   * Liste de fichiers pré-calculée (relative au rootDir). Si fournie,
   * skip le `discoverFiles` walk fs récursif (~500ms sur Sentinel).
   * Utilisé par le watcher mode (Sprint 10) qui maintient la liste
   * en RAM et la met à jour sur fs events.
   */
  preDiscoveredFiles?: string[]
}

export async function analyze(
  config: CodeGraphConfig,
  options: AnalyzeOptions = {},
): Promise<AnalyzeResult> {
  const factsOnly = options.factsOnly ?? false
  const incremental = options.incremental ?? false
  const skipPersistenceLoad = options.skipPersistenceLoad ?? false
  const skipPersistenceSave = options.skipPersistenceSave ?? false
  const t0 = performance.now()
  const timing: AnalyzeResult['timing'] = {
    total: 0,
    fileDiscovery: 0,
    detectors: {},
    graphBuild: 0,
  }

  // ─── 1. Discover files ──────────────────────────────────────────────
  // Sprint 10 : si `preDiscoveredFiles` est fourni (par le watcher qui
  // maintient sa liste en RAM via fs events), skip le walk fs récursif.
  // Sur Sentinel : ~500ms évités par run warm.

  const tFiles = performance.now()
  const files = options.preDiscoveredFiles
    ?? await discoverFiles(config.rootDir, config.include, config.exclude)
  timing.fileDiscovery = performance.now() - tFiles

  // ─── 2. Build read cache ────────────────────────────────────────────

  const fileCache = new Map<string, string>()

  async function readFile(relativePath: string): Promise<string> {
    if (fileCache.has(relativePath)) {
      return fileCache.get(relativePath)!
    }
    const absPath = path.join(config.rootDir, relativePath)
    try {
      const content = await fs.readFile(absPath, 'utf-8')
      fileCache.set(relativePath, content)
      return content
    } catch {
      return ''
    }
  }

  const ctx: DetectorContext = {
    rootDir: config.rootDir,
    files,
    readFile,
    tsconfigPath: config.tsconfigPath,
  }

  // ─── 3. Load disk cache (Sprint 7) ──────────────────────────────────
  // Si on a un .codegraph/salsa-cache.json valide, on restaure les
  // cells + mtimes AVANT toute autre étape. Permet le warm cross-process
  // via CLI : 2e `codegraph analyze --incremental` benéficie du cache
  // disque même dans un nouveau process.
  //
  // Sprint 9 : skipPersistenceLoad permet au watcher de ne pas relire
  // le disque entre analyzes (la DB reste en RAM).
  if (incremental && !skipPersistenceLoad) {
    try {
      const loaded = await incLoadPersistedCache(config.rootDir, incSharedDb)
      if (loaded) {
        incLoadMtimeMap(loaded.mtimes)
      }
    } catch {
      // Cache corrompu — on continue cold, save écrasera au final.
    }
  }

  // ─── 3b. Pre-build shared Project (incremental mode only, Sprint 6) ──
  let preBuiltSharedProject: ReturnType<typeof createSharedProject> | null = null
  if (incremental) {
    preBuiltSharedProject = await prebuildSharedProjectIncremental(
      config, files, fileCache,
    )
  }

  // ─── 4. Run base detectors + build graph ───────────────────────────

  const graph = await runBaseDetectorsAndBuildGraph(
    config, files, fileCache, ctx, incremental, timing,
  )

  // ─── 5. tsconfig resolution + shared Project + Salsa async inputs ──

  const { tsConfigPath, sharedProject } = await resolveTsConfigAndSharedProject(
    config, files, incremental, preBuiltSharedProject,
  )

  // ─── 5. Detectors via Registry (Phase B refactor terminé) ──────────
  // Tous les détecteurs Phase 5 sont migrés au pattern Detector/Registry.
  // L'ordre d'enregistrement détermine l'ordre d'exécution : typed-calls
  // doit tourner avant data-flows (qui le lit via ctx.results).

  const detectorRegistry = new DetectorRegistry()
    .register(new UnusedExportsDetector())
    .register(new ComplexityDetector())
    .register(new SymbolRefsDetector())
    .register(new TypedCallsDetector())
    .register(new CyclesDetector())
    .register(new TruthPointsDetector())
    .register(new DataFlowsDetector())
    .register(new StateMachinesDetector())
    .register(new EnvUsageDetector())
    .register(new PackageDepsDetector())
    .register(new BarrelsDetector())
    .register(new EventEmitSitesDetector())
    .register(new OauthScopeLiteralsDetector())
    .register(new TaintDetector())
    .register(new SqlSchemaDetector())
    .register(new DrizzleSchemaDetector())

  const detectorCtx: DetectorRunContext = {
    config,
    files,
    sharedProject,
    graph,
    tsConfigPath,
    readFile,
    options: { factsOnly, incremental },
    results: {},
  }
  await detectorRegistry.runAll(detectorCtx, timing.detectors)

  // ─── 6. Generate snapshot + patch detector results ────────────────

  const snapshot = graph.toSnapshot()
  patchSnapshotWithDetectorResults(snapshot, detectorCtx.results)

  // ─── 6b. New deterministic detectors (Sprint 12) ───────────────────
  if (!factsOnly) {
    await runDeterministicDetectors(config, files, readFile, sharedProject, snapshot, timing, incremental)
  } else {
    // ─── factsOnly always-run subset ─────────────────────────────────
    // test-coverage est cheap (import-based mapping) ET load-bearing
    // pour la rule composite-hub-untested (CI gate datalog). Sans lui,
    // tout fichier hub testé apparaît comme untested → faux positifs
    // bloquants au pre-commit. Cf. Sentinel pre-commit hook qui fait
    // `codegraph facts --regen` (mode factsOnly) puis exécute
    // datalog-invariants test : hub testé sans TestedFile → fail.
    const tCovFO = performance.now()
    try {
      const testCoverageFO = await analyzeTestCoverage(config.rootDir, files, snapshot.edges)
      snapshot.testCoverage = testCoverageFO
      timing.detectors['test-coverage'] = performance.now() - tCovFO
    } catch (err) {
      timing.detectors['test-coverage'] = performance.now() - tCovFO
      console.error(`  ✗ test-coverage (factsOnly) failed: ${err}`)
    }
  }

  // ─── 7. Post-snapshot metrics phase ────────────────────────────────
  // module-metrics, component-metrics, dsm. Tournent post-snapshot car
  // dépendent de snapshot.nodes + snapshot.edges (cf. helper).
  await runPostSnapshotMetrics(config, snapshot, timing, { factsOnly, incremental })

  // ─── Persist disk cache (Sprint 7) ───────────────────────────────────
  // À la fin d'un run incremental, sauve cells + mtimes pour qu'un
  // process ultérieur (CLI) bénéficie du warm.
  //
  // Sprint 9 : skipPersistenceSave permet au watcher de ne pas écrire
  // ~3 MB à chaque change. Le caller du watcher save périodiquement
  // ou au stop.
  if (incremental && !skipPersistenceSave) {
    try {
      await incSavePersistedCache(config.rootDir, incGetMtimeMap(), incSharedDb)
    } catch {
      // Échec de save = pas bloquant. Le run a réussi.
    }
  }

  timing.total = performance.now() - t0

  return { snapshot, timing }
}

/**
 * Run base detectors (ts-imports, event-bus, http-routes, bullmq-queues,
 * db-tables) + build the file/edge graph + compute orphan status.
 *
 * En mode incremental : ts-imports passe par allTsImports (Salsa cache)
 * au lieu du détecteur legacy — skip dans la boucle pour éviter le
 * double-scan. Le prebuilt sharedProject est reset à null après cette
 * phase pour forcer les détecteurs aval à passer par sharedProject
 * explicitement.
 */
async function runBaseDetectorsAndBuildGraph(
  config: CodeGraphConfig,
  files: string[],
  fileCache: Map<string, string>,
  ctx: DetectorContext,
  incremental: boolean,
  timing: AnalyzeResult['timing'],
): Promise<CodeGraph> {
  const detectors = createDetectors(config.detectors)
  const allLinks: DetectedLink[] = []

  const skipDetectors = new Set<string>()
  if (incremental) {
    skipDetectors.add('ts-imports')
    const tTsImports = performance.now()
    try {
      const links = incAllTsImports.get('all')
      allLinks.push(...links)
    } catch (err) {
      console.error(`  ✗ ts-imports (Salsa) failed: ${err}`)
    }
    timing.detectors['ts-imports'] = performance.now() - tTsImports
  }

  for (const detector of detectors) {
    if (skipDetectors.has(detector.name)) continue
    const tDet = performance.now()
    try {
      const links = await detector.detect(ctx)
      allLinks.push(...links)
      timing.detectors[detector.name] = performance.now() - tDet
    } catch (err) {
      const elapsed = performance.now() - tDet
      timing.detectors[detector.name] = elapsed
      console.error(`  ✗ ${detector.name} failed (${elapsed.toFixed(0)}ms): ${err}`)
    }
  }

  if (incremental) setTsImportPrebuiltProject(null)

  const tGraph = performance.now()
  const graph = new CodeGraph(config.rootDir, config.entryPoints)
  for (const file of files) {
    const content = fileCache.get(file) || ''
    const loc = content.split('\n').length
    graph.addFileNode(file, { loc })
  }
  for (const link of allLinks) {
    if (link.to === 'UNRESOLVED_ROUTE') continue
    graph.addEdge(link.from, link.to, link.type, {
      label: link.label,
      resolved: link.resolved,
      line: link.line,
      meta: link.meta,
    })
  }
  graph.computeOrphanStatus()
  timing.graphBuild = performance.now() - tGraph

  return graph
}

/**
 * Résolution tsconfig + setup du sharedProject ts-morph + alimentation
 * des inputs async Salsa (manifests, sql defaults).
 *
 * En mode incremental : réutilise `preBuiltSharedProject` (construit
 * AVANT la boucle base detectors pour que ts-imports Salsa l'utilise).
 * Set les inputs `packageManifests` et `sqlDefaults` (async I/O)
 * pour que les détecteurs Salsa aval (package-deps, state-machines) y
 * accèdent.
 *
 * En mode legacy : crée un Project frais à chaque appel.
 */
async function resolveTsConfigAndSharedProject(
  config: CodeGraphConfig,
  files: string[],
  incremental: boolean,
  preBuiltSharedProject: ReturnType<typeof createSharedProject> | null,
): Promise<{
  tsConfigPath: string | undefined
  sharedProject: ReturnType<typeof createSharedProject>
}> {
  // Find tsconfig for alias resolution.
  let tsConfigPath: string | undefined
  const tsConfigCandidates: string[] = []
  if (config.tsconfigPath) {
    tsConfigCandidates.push(
      path.isAbsolute(config.tsconfigPath)
        ? config.tsconfigPath
        : path.join(config.rootDir, config.tsconfigPath),
    )
  }
  tsConfigCandidates.push(path.join(config.rootDir, 'tsconfig.json'))
  for (const candidate of tsConfigCandidates) {
    try {
      await fs.access(candidate)
      tsConfigPath = candidate
      break
    } catch {}
  }

  let sharedProject: ReturnType<typeof createSharedProject>
  if (incremental) {
    sharedProject = preBuiltSharedProject!

    // Active manifests pour package-deps incremental (filter scope-empty).
    const allManifests = await discoverPackageManifests(config.rootDir)
    if (allManifests.length > 0) {
      allManifests.sort((a, b) => b.dir.length - a.dir.length)
      const scopeFileCount = new Map<string, number>()
      for (const m of allManifests) scopeFileCount.set(m.abs, 0)
      for (const rel of files) {
        const abs = path.join(config.rootDir, rel)
        const m = findClosestPackageManifest(abs, allManifests)
        if (m) scopeFileCount.set(m.abs, (scopeFileCount.get(m.abs) ?? 0) + 1)
      }
      const activeManifests = allManifests.filter((m) => (scopeFileCount.get(m.abs) ?? 0) > 0)
      incSetInputIfChanged(incPackageManifests, 'all', activeManifests)
    } else {
      incSetInputIfChanged(incPackageManifests, 'all', [])
    }

    // SQL defaults pour state-machines (async file reads → input Salsa).
    const sqlDefaultsBuffer: StateMachineWriteSignal[] = []
    try {
      const sqlFiles = await discoverSqlFilesForIncremental(config.rootDir, ['**/*.sql'])
      for (const sqlFile of sqlFiles) {
        try {
          const content = await fs.readFile(path.join(config.rootDir, sqlFile), 'utf-8')
          scanSqlColumnDefaultsForIncremental(content, sqlFile, sqlDefaultsBuffer)
        } catch {}
      }
    } catch {}
    incSetInputIfChanged(incSqlDefaults, 'all', sqlDefaultsBuffer)
  } else {
    sharedProject = createSharedProject(config.rootDir, files, tsConfigPath)
  }

  return { tsConfigPath, sharedProject }
}

/**
 * Pre-build le sharedProject ts-morph en mode incremental.
 *
 * Sprint 6 : on construit le Project AVANT la boucle des détecteurs
 * pour que TsImportDetector puisse le réutiliser (vs créer son propre
 * Project — qui doublait le coût parse, ~7s sur Sentinel warm).
 *
 * Sprint 11 : on alimente aussi fileContent + projectFiles AVANT la
 * boucle pour que `allTsImports.get('all')` puisse remplacer le
 * détecteur legacy ts-imports (warm 109ms → <10ms via cache Salsa).
 */
async function prebuildSharedProjectIncremental(
  config: CodeGraphConfig,
  files: string[],
  fileCache: Map<string, string>,
): Promise<ReturnType<typeof createSharedProject>> {
  // Find tsconfig
  let earlyTsConfigPath: string | undefined
  const earlyCandidates: string[] = []
  if (config.tsconfigPath) {
    earlyCandidates.push(
      path.isAbsolute(config.tsconfigPath)
        ? config.tsconfigPath
        : path.join(config.rootDir, config.tsconfigPath),
    )
  }
  earlyCandidates.push(path.join(config.rootDir, 'tsconfig.json'))
  for (const candidate of earlyCandidates) {
    try { await fs.access(candidate); earlyTsConfigPath = candidate; break } catch {}
  }

  // Capture previous mtimes for Project cache reuse
  const previousMtimes = new Map<string, number>()
  for (const f of files) {
    const m = incGetCachedMtime(f)
    if (m !== undefined) previousMtimes.set(f, m)
  }

  const project = await incGetOrBuildProject(
    config.rootDir, files, earlyTsConfigPath, previousMtimes, fileCache,
  )
  setIncrementalContext({ project, rootDir: config.rootDir })
  setTsImportPrebuiltProject(project)

  // Feed fileContent + projectFiles inputs so Salsa queries can hit cache
  for (const f of files) {
    const absPath = path.join(config.rootDir, f)
    let mtime: number | undefined
    try {
      const stat = await fs.stat(absPath)
      mtime = stat.mtimeMs
    } catch {}
    const cachedMtime = incGetCachedMtime(f)
    const cellExists = incFileContent.has(f)
    if (mtime !== undefined && cachedMtime === mtime && cellExists) continue
    let content = fileCache.get(f)
    if (content === undefined) {
      try {
        content = await fs.readFile(absPath, 'utf-8')
        fileCache.set(f, content)
      } catch { content = '' }
    }
    incFileContent.set(f, content)
    if (mtime !== undefined) incSetCachedMtime(f, mtime)
  }
  incSetInputIfChanged(incProjectFiles, 'all', files)

  return project
}

/**
 * Run les détecteurs déterministes : timing tracké, errors loguées sans
 * bloquer le pipeline, results assignés directement au snapshot.
 *
 * Refactor 2026-05 : extraction du wrapper try/catch+timing répétitif
 * dans le helper `runDetectorTimed()`. 39 détecteurs invoqués via une
 * liste déclarative au lieu de 39 blocks copiés-collés.
 *
 * Préserve la sémantique exacte du legacy : ordre d'invocation, gestion
 * d'erreur (log mais pas throw), assignation conditionnelle (`if (x)`).
 */
async function runDeterministicDetectors(
  config: CodeGraphConfig,
  files: string[],
  readFile: (relativePath: string) => Promise<string>,
  sharedProject: ReturnType<typeof createSharedProject>,
  snapshot: GraphSnapshot,
  timing: AnalyzeResult['timing'],
  incremental: boolean = false,
): Promise<void> {
  // Phase 1 : détecteurs indépendants (pas de cross-deps).
  const todos = await runDetectorTimed(timing, 'todos',
    () => analyzeTodos(config.rootDir, files, readFile))
  const longFunctions = await runDetectorTimed(timing, 'long-functions',
    () => analyzeLongFunctions(config.rootDir, files, sharedProject))
  const magicNumbers = await runDetectorTimed(timing, 'magic-numbers',
    () => analyzeMagicNumbers(config.rootDir, files, sharedProject))
  const testCoverage = await runDetectorTimed(timing, 'test-coverage',
    () => analyzeTestCoverage(config.rootDir, files, snapshot.edges))
  const coChangePairs = await runDetectorTimed(timing, 'co-change',
    () => {
      const knownFilesArr = snapshot.nodes
        .filter((n) => n.type === 'file').map((n) => n.id).sort()
      if (incremental) {
        // Salsa-iso : keying sur (gitHead, knownFiles). Cache hit warm
        // tant que HEAD n'a pas bougé et les fichiers connus sont stables.
        incSetInputIfChanged(incCoChangeGitHead, 'all', getGitHead(config.rootDir))
        incSetInputIfChanged(incCoChangeKnownFiles, 'all', knownFilesArr)
        return Promise.resolve(incAllCoChangePairs.get('all'))
      }
      return analyzeCoChange(config.rootDir, { knownFiles: new Set(knownFilesArr) })
    })

  // Phase 2 : détecteurs avec dep sur Phase 1.
  // drift-patterns dépend de todos (pattern 3) — run après.
  const driftSignals = await runDetectorTimed(timing, 'drift-patterns',
    () => {
      if (incremental) {
        // Salsa cache UNIQUEMENT les patterns 1+2+4+5 (per-file AST).
        // Pattern 3 (todo-no-owner) dépend de snapshot.todos (extracteur
        // séparé) — on l'ajoute hors-cache puis on re-trie globalement.
        const astSignals = incAllDriftPatternsAst.get('all')
        const todoSignals = (todos ?? [])
          .map(todoToDriftSignal)
          .filter((s): s is NonNullable<typeof s> => s !== null)
        const merged = [...astSignals, ...todoSignals]
        merged.sort((a, b) => {
          if (a.file !== b.file) return a.file < b.file ? -1 : 1
          if (a.line !== b.line) return a.line - b.line
          return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0
        })
        return Promise.resolve(merged)
      }
      return analyzeDriftPatterns(config.rootDir, files, sharedProject, todos)
    })
  const evalCalls = await runDetectorTimed(timing, 'eval-calls',
    () => analyzeEvalCalls(config.rootDir, files, sharedProject))
  const cryptoCalls = await runDetectorTimed(timing, 'crypto-algo',
    () => analyzeCryptoCalls(config.rootDir, files, sharedProject))
  // Self-optim discovery : Salsa-isolation post-λ_lyap analysis.
  // Cold path identique au legacy ; warm path = cache hit ~99%.
  const securityPatterns = await runDetectorTimed(timing, 'security-patterns',
    () => incremental
      ? Promise.resolve(incAllSecurityPatterns.get('all'))
      : analyzeSecurityPatterns(config.rootDir, files, sharedProject))
  const eventListenerSites = await runDetectorTimed(timing, 'event-listener-sites',
    () => analyzeEventListenerSites(config.rootDir, files, sharedProject))
  const codeQualityPatterns = await runDetectorTimed(timing, 'code-quality-patterns',
    () => incremental
      ? Promise.resolve(incAllCodeQualityPatterns.get('all'))
      : analyzeCodeQualityPatterns(config.rootDir, files, sharedProject))
  const functionComplexity = await runDetectorTimed(timing, 'function-complexity',
    () => analyzeFunctionComplexity(config.rootDir, files, sharedProject))

  // Phase 3 : cross-discipline orchestrator — 11 disciplines mathématiques.
  // Extrait dans `extractors/_shared/cross-discipline-orchestrator.ts` +
  // wrappé en CrossDisciplineDetector class. L'orchestrator retourne
  // directement (pas via DetectorRegistry car celui-ci tourne pre-snapshot).
  const _crossDisciplineDetector = new CrossDisciplineDetector()
  void _crossDisciplineDetector  // marker : pattern POC valid
  const cross = await runCrossDisciplineDetectors({
    rootDir: config.rootDir,
    files, sharedProject, snapshot, coChangePairs, timing,
  })

  // Phase 4 : security + quality detectors indépendants.
  const hardcodedSecrets = await runDetectorTimed(timing, 'hardcoded-secrets',
    () => analyzeHardcodedSecrets(config.rootDir, files, sharedProject))
  const booleanParams = await runDetectorTimed(timing, 'boolean-params',
    () => analyzeBooleanParams(config.rootDir, files, sharedProject))
  const deadCode = await runDetectorTimed(timing, 'dead-code',
    () => incremental
      ? Promise.resolve(incAllDeadCode.get('all'))
      : analyzeDeadCode(config.rootDir, files, sharedProject))
  // floating-promises : dep sur snapshot.typedCalls (déjà patché Phase 5).
  const floatingPromises = await runDetectorTimed(timing, 'floating-promises',
    () => analyzeFloatingPromises(config.rootDir, files, sharedProject, snapshot.typedCalls))
  const deprecatedUsage = await runDetectorTimed(timing, 'deprecated-usage',
    () => incremental
      ? Promise.resolve(incAllDeprecatedUsage.get('all'))
      : analyzeDeprecatedUsage(config.rootDir, files, sharedProject))
  const articulationPoints = await runDetectorTimed(timing, 'articulation-points',
    () => analyzeArticulationPoints(snapshot))

  // Constant expressions — patterns simplification symbolique (tautology,
  // contradiction, gratuitous bool comparison). Cf. extractor.
  const constantExpressions = await runDetectorTimed(timing, 'constant-expressions',
    () => incremental
      ? Promise.resolve(incAllConstantExpressions.get('all'))
      : analyzeConstantExpressionsBatch(config.rootDir, files, sharedProject))

  // ESLint ingester — read .codegraph/eslint.json if user provided it.
  const eslintViolations = await runDetectorTimed(timing, 'eslint-import',
    () => importEslintViolations(config.rootDir))

  // Phase 5 : SQL detectors (gated sur snapshot.sqlSchema).
  const sqlNamingViolations = await runDetectorTimed(timing, 'sql-naming',
    async () => snapshot.sqlSchema ? findSqlNamingViolations(snapshot.sqlSchema) : undefined)
  const sqlMigrationOrderViolations = await runDetectorTimed(timing, 'sql-migration-order',
    async () => snapshot.sqlSchema ? findMigrationOrderViolations(snapshot.sqlSchema) : undefined)
  const resourceImbalances = await runDetectorTimed(timing, 'resource-balance',
    () => analyzeResourceBalance(config.rootDir, files, sharedProject))

  // Phase 6 : taint analysis chain.
  const taintSinks = await runDetectorTimed(timing, 'taint-sinks',
    () => analyzeTaintSinks(config.rootDir, files, sharedProject))
  const sanitizerCalls = await runDetectorTimed(timing, 'sanitizers',
    () => analyzeSanitizers(config.rootDir, files, sharedProject))
  const taintedVars = await runDetectorTimed(timing, 'tainted-vars',
    () => analyzeTaintedVars(config.rootDir, files, sharedProject))
  const argumentsFacts = await runDetectorTimed(timing, 'arguments',
    () => analyzeArguments(config.rootDir, files, sharedProject))

  // Patch snapshot avec tous les results (assignation conditionnelle —
  // si un détecteur a failed, son champ reste non-set).
  assignIfDefined(snapshot, {
    todos, longFunctions, magicNumbers, testCoverage, coChangePairs,
    driftSignals, evalCalls, cryptoCalls, securityPatterns, eventListenerSites,
    codeQualityPatterns, functionComplexity,
    spectralMetrics: cross.spectralMetrics,
    symbolEntropy: cross.symbolEntropy,
    signatureDuplicates: cross.signatureDuplicates,
    persistentCycles: cross.persistentCycles,
    lyapunovMetrics: cross.lyapunovMetrics,
    packageMinCuts: cross.packageMinCuts,
    informationBottlenecks: cross.informationBottlenecks,
    importCommunities: cross.importCommunities,
    modularityScore: cross.modularityScore,
    factStabilities: cross.factStabilities,
    bayesianCoChanges: cross.bayesianCoChanges,
    compressionDistances: cross.compressionDistances,
    grangerCausalities: cross.grangerCausalities,
    hardcodedSecrets, booleanParams, deadCode, floatingPromises, deprecatedUsage,
    articulationPoints, sqlNamingViolations, sqlMigrationOrderViolations,
    resourceImbalances, taintSinks, sanitizerCalls, taintedVars, argumentsFacts,
    constantExpressions, eslintViolations,
  })
}

/**
 * Wrapper batch pour `extractConstantExpressionsFileBundle` per-file.
 * Pattern ADR-005 : per-file extractor + batch aggregator.
 */
async function analyzeConstantExpressionsBatch(
  rootDir: string,
  files: string[],
  project: ReturnType<typeof createSharedProject>,
): Promise<ConstantExpressionFinding[]> {
  const fileSet = new Set(files)
  const out: ConstantExpressionFinding[] = []
  for (const sf of project.getSourceFiles()) {
    const absPath = sf.getFilePath() as string
    const relPath = path.relative(rootDir, absPath).replace(/\\/g, '/')
    if (!fileSet.has(relPath)) continue
    const bundle = extractConstantExpressionsFileBundle(sf, relPath)
    out.push(...bundle.findings)
  }
  // Determinism (already sorted per-file, but resort globally)
  out.sort((a, b) =>
    a.file !== b.file ? (a.file < b.file ? -1 : 1) :
    a.line !== b.line ? a.line - b.line :
    a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0,
  )
  return out
}

/**
 * Helper : run un détecteur avec wrapping timing + try/catch standard.
 * Extrait du legacy bloc dupliqué 39× dans `runDeterministicDetectors`.
 *
 * Sémantique préservée :
 *   - Timing toujours mesuré (try ET catch path).
 *   - Errors loguées via console.error sans throw (pipeline continue).
 *   - Retourne `undefined` si le détecteur fail OU retourne `undefined`.
 */
async function runDetectorTimed<T>(
  timing: AnalyzeResult['timing'],
  name: string,
  fn: () => Promise<T | undefined> | T | undefined,
): Promise<T | undefined> {
  const t0 = performance.now()
  try {
    const result = await fn()
    timing.detectors[name] = performance.now() - t0
    return result
  } catch (err) {
    timing.detectors[name] = performance.now() - t0
    console.error(`  ✗ ${name} failed: ${err}`)
    return undefined
  }
}

/**
 * Helper : assigne dans `snapshot` chaque clé du `results` dont la valeur
 * n'est pas `undefined`. Préserve l'idiome legacy `if (x) snapshot.x = x`
 * en une seule expression.
 */
function assignIfDefined(
  snapshot: GraphSnapshot,
  results: Partial<Record<keyof GraphSnapshot, unknown>>,
): void {
  // Type-safe assignment : la table `results` est déjà typée par
  // `Partial<Record<keyof GraphSnapshot, unknown>>`, le runtime check sur
  // undefined préserve les types attendus côté caller. Le cast via
  // `unknown as Record<string, unknown>` est requis par strict TS car
  // GraphSnapshot n'a pas d'index signature.
  const target = snapshot as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(results)) {
    if (value !== undefined) target[key] = value
  }
}

/**
 * Patch les results des détecteurs Phase 5 dans le snapshot final. Le
 * mapping name (Detector.name) → snapshot field est explicite ici. Si un
 * détecteur n'a pas produit de résultat (disabled / failed / undefined
 * return), la clé n'existe pas dans `results` et le snapshot field reste
 * non-set. Préserve la parité bit-pour-bit avec le legacy
 * `if (X) snapshot.x = X` répété.
 */
function patchSnapshotWithDetectorResults(
  snapshot: GraphSnapshot,
  results: Record<string, unknown>,
): void {
  const mapping: Array<[string, keyof GraphSnapshot]> = [
    ['symbol-refs', 'symbolRefs'],
    ['typed-calls', 'typedCalls'],
    ['cycles', 'cycles'],
    ['truth-points', 'truthPoints'],
    ['data-flows', 'dataFlows'],
    ['state-machines', 'stateMachines'],
    ['env-usage', 'envUsage'],
    ['package-deps', 'packageDeps'],
    ['barrels', 'barrels'],
    ['taint', 'taintViolations'],
    ['event-emit-sites', 'eventEmitSites'],
    ['oauth-scope-literals', 'oauthScopeLiterals'],
    ['sql-schema', 'sqlSchema'],
    // 'drizzle-schema' partage le même snapshot field. Si le détecteur
    // Drizzle a des résultats, il aura déjà mergé sql-schema dans son
    // propre output via ctx.results, donc l'écrasement est correct. Si
    // Drizzle n'a rien (tables.length === 0), il retourne undefined →
    // sql-schema est conservé.
    ['drizzle-schema', 'sqlSchema'],
  ]
  for (const [detectorName, snapshotField] of mapping) {
    const value = results[detectorName]
    if (value !== undefined) {
      ;(snapshot as any)[snapshotField] = value
    }
  }
}

/**
 * Phase post-snapshot : métriques qui dépendent de `snapshot.nodes` et
 * `snapshot.edges`. Pattern Detector ne s'applique pas (ces phases ont
 * besoin du snapshot final, pas du graph en construction).
 *
 *   - module-metrics : PageRank + fan-in/out + Henry-Kafura
 *   - component-metrics : Martin I/A/D
 *   - dsm : container-level pré-calcul pour le panneau web
 *
 * Toutes désactivables via `detectorOptions.<name>.enabled = false`.
 * factsOnly skip component-metrics + dsm (mais pas module-metrics —
 * utilisé pour le ranking dans le boot brief).
 */
async function runPostSnapshotMetrics(
  config: CodeGraphConfig,
  snapshot: GraphSnapshot,
  timing: AnalyzeResult['timing'],
  options: { factsOnly: boolean; incremental: boolean },
): Promise<void> {
  const { factsOnly, incremental } = options

  // module-metrics
  const moduleMetricsEnabled =
    (config.detectorOptions?.['moduleMetrics']?.['enabled'] as boolean | undefined) ?? true
  const tModuleMetrics = performance.now()
  if (moduleMetricsEnabled) {
    try {
      const mmOptions = config.detectorOptions?.['moduleMetrics'] ?? {}
      if (incremental) {
        incSetInputIfChanged(incGraphNodes, 'all', snapshot.nodes)
        incSetInputIfChanged(incGraphEdgesForMetrics, 'all', snapshot.edges)
        snapshot.moduleMetrics = incAllModuleMetrics.get('all')
      } else {
        snapshot.moduleMetrics = computeModuleMetrics(
          snapshot.nodes,
          snapshot.edges,
          {
            edgeTypesForCentrality: mmOptions['edgeTypesForCentrality'] as any,
            pagerankAlpha: mmOptions['pagerankAlpha'] as number | undefined,
            pagerankTolerance: mmOptions['pagerankTolerance'] as number | undefined,
          },
        )
      }
      timing.detectors['module-metrics'] = performance.now() - tModuleMetrics
    } catch (err) {
      timing.detectors['module-metrics'] = performance.now() - tModuleMetrics
      console.error(`  ✗ module-metrics failed: ${err}`)
    }
  }

  // component-metrics
  const componentMetricsEnabled =
    !factsOnly &&
    ((config.detectorOptions?.['componentMetrics']?.['enabled'] as boolean | undefined) ?? true)
  const tComponentMetrics = performance.now()
  if (componentMetricsEnabled) {
    try {
      const cmOptions = config.detectorOptions?.['componentMetrics'] ?? {}
      if (incremental) {
        if (!incGraphNodes.has('all')) incSetInputIfChanged(incGraphNodes, 'all', snapshot.nodes)
        if (!incGraphEdgesForMetrics.has('all')) incSetInputIfChanged(incGraphEdgesForMetrics, 'all', snapshot.edges)
        snapshot.componentMetrics = incAllComponentMetrics.get('all')
      } else {
        snapshot.componentMetrics = computeComponentMetrics(
          snapshot.nodes,
          snapshot.edges,
          {
            depth: cmOptions['depth'] as number | undefined,
            edgeTypes: cmOptions['edgeTypes'] as any,
            excludeComponents: cmOptions['excludeComponents'] as string[] | undefined,
          },
        )
      }
      timing.detectors['component-metrics'] = performance.now() - tComponentMetrics
    } catch (err) {
      timing.detectors['component-metrics'] = performance.now() - tComponentMetrics
      console.error(`  ✗ component-metrics failed: ${err}`)
    }
  }

  // dsm
  const dsmEnabled =
    !factsOnly &&
    ((config.detectorOptions?.['dsm']?.['enabled'] as boolean | undefined) ?? true)
  const tDsm = performance.now()
  if (dsmEnabled) {
    try {
      const dsmOptions = config.detectorOptions?.['dsm'] ?? {}
      const depth = (dsmOptions['depth'] as number | undefined) ?? 3
      const fileNodes = snapshot.nodes.filter((n) => n.type === 'file').map((n) => n.id)
      const importEdges = snapshot.edges
        .filter((e) => e.type === 'import')
        .map((e) => ({ from: e.from, to: e.to }))
      const agg = aggregateByContainer(fileNodes, importEdges, depth)
      snapshot.dsm = computeDsm(agg.nodes, agg.edges)
      timing.detectors['dsm'] = performance.now() - tDsm
    } catch (err) {
      timing.detectors['dsm'] = performance.now() - tDsm
      console.error(`  ✗ dsm failed: ${err}`)
    }
  }
}

// ─── File Discovery ─────────────────────────────────────────────────────
// Extrait dans `core/file-discovery.ts` (refactor god-file 2026-05).
// Re-export pour préserver l'API publique.
export { discoverFiles } from './file-discovery.js'
