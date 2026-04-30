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
import type {
  CodeGraphConfig,
  DetectorContext,
  DetectedLink,
  GraphSnapshot,
  EnvVarUsage,
  PackageDepsIssue,
  BarrelInfo,
  TypedCalls,
  Cycle,
  TruthPoint,
  DataFlow,
  StateMachine,
  TaintViolation,
} from './types.js'
import { createDetectors } from '../detectors/index.js'
import { createSharedProject } from '../extractors/unused-exports.js'
import type { EventEmitSite } from '../extractors/event-emit-sites.js'
import type { OauthScopeLiteral } from '../extractors/oauth-scope-literals.js'
import { DetectorRegistry, type DetectorRunContext } from './detector-registry.js'
import { OauthScopeLiteralsDetector } from './detectors/oauth-scope-literals-detector.js'
import { EventEmitSitesDetector } from './detectors/event-emit-sites-detector.js'
import { EnvUsageDetector } from './detectors/env-usage-detector.js'
import { PackageDepsDetector } from './detectors/package-deps-detector.js'
import { BarrelsDetector } from './detectors/barrels-detector.js'
import { UnusedExportsDetector } from './detectors/unused-exports-detector.js'
import { ComplexityDetector } from './detectors/complexity-detector.js'
import { SymbolRefsDetector, type SymbolRefEdge } from './detectors/symbol-refs-detector.js'
import { TypedCallsDetector } from './detectors/typed-calls-detector.js'
import { CyclesDetector } from './detectors/cycles-detector.js'
import { TruthPointsDetector } from './detectors/truth-points-detector.js'
import { DataFlowsDetector } from './detectors/data-flows-detector.js'
import { StateMachinesDetector } from './detectors/state-machines-detector.js'
import { TaintDetector } from './detectors/taint-detector.js'
import { analyzeTodos, type TodoMarker } from '../extractors/todos.js'
import { analyzeLongFunctions, type LongFunction } from '../extractors/long-functions.js'
import { analyzeMagicNumbers, type MagicNumber } from '../extractors/magic-numbers.js'
import { analyzeTestCoverage, type TestCoverageReport } from '../extractors/test-coverage.js'
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

  // ─── 4. Run detectors ──────────────────────────────────────────────

  const detectors = createDetectors(config.detectors)
  const allLinks: DetectedLink[] = []

  // Sprint 11 : en mode incremental, ts-imports passe par allTsImports
  // (Salsa cache per-file) au lieu du détecteur legacy. Skip dans la
  // boucle pour éviter le double-scan.
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

  // Reset le prebuilt — autres détecteurs qui en auraient besoin
  // doivent passer par sharedProject explicitement.
  if (incremental) setTsImportPrebuiltProject(null)

  // ─── 4. Build graph ────────────────────────────────────────────────

  const tGraph = performance.now()
  const graph = new CodeGraph(config.rootDir, config.entryPoints)

  // Add all discovered files as nodes
  for (const file of files) {
    const content = fileCache.get(file) || ''
    const loc = content.split('\n').length
    graph.addFileNode(file, { loc })
  }

  // Add all detected edges
  for (const link of allLinks) {
    // Skip unresolved route targets (placeholder)
    if (link.to === 'UNRESOLVED_ROUTE') continue

    graph.addEdge(link.from, link.to, link.type, {
      label: link.label,
      resolved: link.resolved,
      line: link.line,
      meta: link.meta,
    })
  }

  // Compute orphan status after all edges are in
  graph.computeOrphanStatus()

  timing.graphBuild = performance.now() - tGraph

  // ─── 5. tsconfig resolution + shared Project ───────────────────────

  // Find tsconfig for alias resolution. Priorité :
  //   1. config.tsconfigPath (depuis CodeGraphConfig — projet-spécifique)
  //   2. Fallback : tsconfig.json à la racine
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

  // Projet ts-morph partagé.
  // En mode incremental : déjà construit en step 3 (preBuiltSharedProject)
  //   et setIncrementalContext fait. On le réutilise.
  // En mode legacy : créer un Project frais (pattern actuel).
  let sharedProject: ReturnType<typeof createSharedProject>

  if (incremental) {
    sharedProject = preBuiltSharedProject!
    // fileContent + projectFiles déjà set en step 3b (Sprint 11).
    // Ici : manifests + sqlDefaults qui ne sont nécessaires que pour
    // les détecteurs Salsa appelés plus tard (package-deps, state-machines).

    // Discovery + filter active manifests pour package-deps incremental.
    // C'est async donc fait ici, pas dans une derived query (sync only).
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

    // SQL defaults pour state-machines : async file reads ici.
    // Set en input Salsa pour que allStateMachines puisse les inclure
    // dans son agrégation sync.
    const sqlDefaultsBuffer: StateMachineWriteSignal[] = []
    try {
      const sqlGlobs = ['**/*.sql']
      const sqlFiles = await discoverSqlFilesForIncremental(config.rootDir, sqlGlobs)
      for (const sqlFile of sqlFiles) {
        try {
          const content = await fs.readFile(path.join(config.rootDir, sqlFile), 'utf-8')
          scanSqlColumnDefaultsForIncremental(content, sqlFile, sqlDefaultsBuffer)
        } catch {}
      }
    } catch {}
    incSetInputIfChanged(incSqlDefaults, 'all', sqlDefaultsBuffer)
  } else {
    // Mode legacy : Project frais à chaque appel (pas de cache cross-run).
    sharedProject = createSharedProject(config.rootDir, files, tsConfigPath)
  }

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

  const symbolRefs = detectorCtx.results['symbol-refs'] as
    | SymbolRefEdge[]
    | undefined
  const typedCalls = detectorCtx.results['typed-calls'] as
    | TypedCalls
    | undefined
  const cycles = detectorCtx.results['cycles'] as Cycle[] | undefined
  const truthPoints = detectorCtx.results['truth-points'] as TruthPoint[] | undefined
  const dataFlows = detectorCtx.results['data-flows'] as DataFlow[] | undefined
  const stateMachines = detectorCtx.results['state-machines'] as StateMachine[] | undefined
  const envUsage = detectorCtx.results['env-usage'] as
    | EnvVarUsage[]
    | undefined
  const packageDeps = detectorCtx.results['package-deps'] as
    | PackageDepsIssue[]
    | undefined
  const barrels = detectorCtx.results['barrels'] as
    | BarrelInfo[]
    | undefined
  const eventEmitSites = detectorCtx.results['event-emit-sites'] as
    | EventEmitSite[]
    | undefined
  const oauthScopeLiterals = detectorCtx.results['oauth-scope-literals'] as
    | OauthScopeLiteral[]
    | undefined
  const taintViolations = detectorCtx.results['taint'] as TaintViolation[] | undefined

  // ─── 6. Generate snapshot ──────────────────────────────────────────

  const snapshot = graph.toSnapshot()
  if (symbolRefs) {
    snapshot.symbolRefs = symbolRefs
  }
  if (typedCalls) {
    snapshot.typedCalls = typedCalls
  }
  if (cycles) {
    snapshot.cycles = cycles
  }
  if (truthPoints) {
    snapshot.truthPoints = truthPoints
  }
  if (dataFlows) {
    snapshot.dataFlows = dataFlows
  }
  if (stateMachines) {
    snapshot.stateMachines = stateMachines
  }
  if (envUsage) {
    snapshot.envUsage = envUsage
  }
  if (packageDeps) {
    snapshot.packageDeps = packageDeps
  }
  if (barrels) {
    snapshot.barrels = barrels
  }
  if (taintViolations) {
    snapshot.taintViolations = taintViolations
  }
  if (eventEmitSites) {
    snapshot.eventEmitSites = eventEmitSites
  }
  if (oauthScopeLiterals) {
    snapshot.oauthScopeLiterals = oauthScopeLiterals
  }

  // ─── 6b. New deterministic detectors (Sprint 12) ───────────────────
  if (!factsOnly) {
    await runDeterministicDetectors(config, files, readFile, sharedProject, snapshot, timing)
  }

  // ─── 7. Module metrics (phase 3.7 #5 + #6) ─────────────────────────
  // PageRank + fan-in/out + Henry-Kafura sur le graphe final (snapshot déjà
  // construit). Calculé post-graph parce qu'il n'a besoin que de
  // `snapshot.nodes` et `snapshot.edges`. Toggle via
  // `detectorOptions.moduleMetrics.enabled` (default on).

  const moduleMetricsEnabled =
    (config.detectorOptions?.['moduleMetrics']?.['enabled'] as boolean | undefined) ?? true

  const tModuleMetrics = performance.now()
  if (moduleMetricsEnabled) {
    try {
      const mmOptions = config.detectorOptions?.['moduleMetrics'] ?? {}
      if (incremental) {
        // Salsa path : nodes+edges déjà construits, on les set en
        // input puis on calcule via le derived. Custom options
        // (edgeTypesForCentrality, alpha, tolerance) non supportés —
        // defaults suffisent pour Sentinel.
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

  // ─── 7b. Component metrics — Martin I/A/D (phase 3.7 #2) ───────────
  const componentMetricsEnabled =
    !factsOnly &&
    ((config.detectorOptions?.['componentMetrics']?.['enabled'] as boolean | undefined) ?? true)

  const tComponentMetrics = performance.now()
  if (componentMetricsEnabled) {
    try {
      const cmOptions = config.detectorOptions?.['componentMetrics'] ?? {}
      if (incremental) {
        // Salsa path : nodes+edges déjà set par module-metrics au-dessus.
        // Custom options non supportés.
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

  // ─── 7c. DSM container-level (phase 3.8 #4) ────────────────────────
  // Précalcul pour le panneau web. File-level pour les gros repos est trop
  // large en JSON et illisible — le consommateur peut régénérer via `codegraph
  // dsm --granularity file`. Toggle via `detectorOptions.dsm.enabled`.

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
 * Run les détecteurs déterministes ajoutés Sprint 12 (TODO/FIXME, long
 * functions, magic numbers, test coverage). Pattern uniforme : timing
 * tracké, errors loguées sans bloquer le pipeline, results patché dans
 * le snapshot.
 *
 * Pas de dépendance lourde, pas de wrapper Salsa pour l'instant —
 * pattern ADR-005 prévu en suivi.
 */
async function runDeterministicDetectors(
  config: CodeGraphConfig,
  files: string[],
  readFile: (relativePath: string) => Promise<string>,
  sharedProject: ReturnType<typeof createSharedProject>,
  snapshot: GraphSnapshot,
  timing: AnalyzeResult['timing'],
): Promise<void> {
  let todos: TodoMarker[] | undefined
  let longFunctions: LongFunction[] | undefined
  let magicNumbers: MagicNumber[] | undefined
  let testCoverage: TestCoverageReport | undefined

  const tTodos = performance.now()
  try {
    todos = await analyzeTodos(config.rootDir, files, readFile)
    timing.detectors['todos'] = performance.now() - tTodos
  } catch (err) {
    timing.detectors['todos'] = performance.now() - tTodos
    console.error(`  ✗ todos failed: ${err}`)
  }

  const tLongFns = performance.now()
  try {
    longFunctions = await analyzeLongFunctions(config.rootDir, files, sharedProject)
    timing.detectors['long-functions'] = performance.now() - tLongFns
  } catch (err) {
    timing.detectors['long-functions'] = performance.now() - tLongFns
    console.error(`  ✗ long-functions failed: ${err}`)
  }

  const tMagic = performance.now()
  try {
    magicNumbers = await analyzeMagicNumbers(config.rootDir, files, sharedProject)
    timing.detectors['magic-numbers'] = performance.now() - tMagic
  } catch (err) {
    timing.detectors['magic-numbers'] = performance.now() - tMagic
    console.error(`  ✗ magic-numbers failed: ${err}`)
  }

  const tCov = performance.now()
  try {
    testCoverage = await analyzeTestCoverage(config.rootDir, files, snapshot.edges)
    timing.detectors['test-coverage'] = performance.now() - tCov
  } catch (err) {
    timing.detectors['test-coverage'] = performance.now() - tCov
    console.error(`  ✗ test-coverage failed: ${err}`)
  }

  if (todos) snapshot.todos = todos
  if (longFunctions) snapshot.longFunctions = longFunctions
  if (magicNumbers) snapshot.magicNumbers = magicNumbers
  if (testCoverage) snapshot.testCoverage = testCoverage
}

// ─── File Discovery ─────────────────────────────────────────────────────

export async function discoverFiles(
  rootDir: string,
  include: string[],
  exclude: string[]
): Promise<string[]> {
  const allFiles: string[] = []
  await walkDir(rootDir, rootDir, allFiles)

  return allFiles.filter(file => {
    const matches = include.some(pattern => minimatch(file, pattern))
    const excluded = exclude.some(pattern => minimatch(file, pattern))
    return matches && !excluded
  })
}

async function walkDir(
  dir: string,
  rootDir: string,
  result: string[]
): Promise<void> {
  // Skip known heavy directories early (before even reading entries)
  const dirName = path.basename(dir)
  const skipDirs = new Set([
    'node_modules', '.git', 'dist', 'build', '.next',
    'coverage', '.turbo', '.cache', 'docker-data',
  ])

  if (skipDirs.has(dirName) && dir !== rootDir) return

  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkDir(fullPath, rootDir, result)
    } else if (entry.isFile()) {
      const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/')
      result.push(relativePath)
    }
  }
}
