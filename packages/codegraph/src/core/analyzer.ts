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
import type { CodeGraphConfig, DetectorContext, DetectedLink, GraphSnapshot } from './types.js'
import { createDetectors } from '../detectors/index.js'
import { analyzeExports, createSharedProject } from '../detectors/unused-exports.js'
import { analyzeComplexity } from '../detectors/complexity.js'
import { analyzeSymbolRefs } from '../detectors/symbol-refs.js'
import { analyzeTypedCalls } from '../extractors/typed-calls.js'
import { analyzeCycles } from '../extractors/cycles.js'
import { analyzeTruthPoints } from '../extractors/truth-points.js'
import { analyzeDataFlows } from '../extractors/data-flows.js'
import { analyzeStateMachines } from '../extractors/state-machines.js'
import { analyzeEnvUsage } from '../extractors/env-usage.js'
import { analyzePackageDeps } from '../extractors/package-deps.js'
import { analyzeBarrels } from '../extractors/barrels.js'
import { analyzeTaint } from '../extractors/taint.js'
import { analyzeEventEmitSites } from '../extractors/event-emit-sites.js'
import { analyzeOauthScopeLiterals } from '../extractors/oauth-scope-literals.js'
import type { TaintRules } from './types.js'
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
}

export async function analyze(
  config: CodeGraphConfig,
  options: AnalyzeOptions = {},
): Promise<AnalyzeResult> {
  const factsOnly = options.factsOnly ?? false
  const t0 = performance.now()
  const timing: AnalyzeResult['timing'] = {
    total: 0,
    fileDiscovery: 0,
    detectors: {},
    graphBuild: 0,
  }

  // ─── 1. Discover files ──────────────────────────────────────────────

  const tFiles = performance.now()
  const files = await discoverFiles(config.rootDir, config.include, config.exclude)
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

  // ─── 3. Run detectors ──────────────────────────────────────────────

  const detectors = createDetectors(config.detectors)
  const allLinks: DetectedLink[] = []

  for (const detector of detectors) {
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

  // ─── 5. Analyze exports (function-level granularity) ───────────────

  const tExports = performance.now()

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

  // Projet ts-morph partagé entre les deux analyses AST qui suivent. Crucial :
  // charger ts-morph deux fois fait sauter le heap Node sur projets ≥ 200 fichiers.
  const sharedProject = createSharedProject(config.rootDir, files, tsConfigPath)

  if (!factsOnly) {
    const exportInfos = await analyzeExports(config.rootDir, files, tsConfigPath, sharedProject)

    // Patch export data into the graph nodes
    for (const info of exportInfos) {
      const node = graph.getNodeById(info.file)
      if (node) {
        graph.setNodeExports(info.file, info.exports, info.totalCount)
      }
    }

    timing.detectors['unused-exports'] = performance.now() - tExports

    // ─── 5b. Cyclomatic complexity par fonction ────────────────────────
    // Parcours des AST pour calculer la complexité cyclomatique. Résultats
    // mergés dans node.meta pour rester compatibles avec les consommateurs
    // actuels (le schéma GraphNode n'a pas besoin de champ dédié).

    const tComplexity = performance.now()
    try {
      const complexityInfos = await analyzeComplexity(config.rootDir, files, tsConfigPath, sharedProject)
      for (const info of complexityInfos) {
        graph.setNodeMeta(info.file, {
          complexity: {
            topFunctions: info.topFunctions,
            maxComplexity: info.maxComplexity,
            avgComplexity: info.avgComplexity,
            totalFunctions: info.totalFunctions,
          },
        })
      }
      timing.detectors['complexity'] = performance.now() - tComplexity
    } catch (err) {
      timing.detectors['complexity'] = performance.now() - tComplexity
      console.error(`  ✗ complexity failed: ${err}`)
    }
  }

  // ─── 5c. Symbol-level references (aider-style) ─────────────────────
  // Construit le graphe function→function : edges (from, to, line) où from/to
  // sont "file:symbolName". Permet :
  //   1. PageRank symbol-level en aval (ranking de fonctions, pas de fichiers).
  //   2. find_references précis sans grep (on a les lignes exactes d'appel
  //      dans les corps de fonctions, plus l'info "appelé depuis quelle fn").
  //
  // Dépend du sharedProject — 3e passage AST mais zero overhead mémoire car
  // on réutilise le même Project.

  const tSymbolRefs = performance.now()
  let symbolRefs: { from: string; to: string; line: number }[] | undefined
  if (!factsOnly) try {
    const result = await analyzeSymbolRefs(config.rootDir, files, sharedProject)
    symbolRefs = result.refs
    timing.detectors['symbol-refs'] = performance.now() - tSymbolRefs
  } catch (err) {
    timing.detectors['symbol-refs'] = performance.now() - tSymbolRefs
    console.error(`  ✗ symbol-refs failed: ${err}`)
  }

  // ─── 5d. Typed calls (structural map phase 1.2) ────────────────────
  // Signatures d'exports + call edges avec types aux sites d'appel. Fondation
  // des extracteurs de flux / cycles / FSM / truth-points. Désactivable via
  // config.detectorOptions.typedCalls.enabled = false (default on).

  const typedCallsEnabled =
    !factsOnly &&
    ((config.detectorOptions?.['typedCalls']?.['enabled'] as boolean | undefined) ?? true)

  const tTypedCalls = performance.now()
  let typedCalls: Awaited<ReturnType<typeof analyzeTypedCalls>> | undefined
  if (typedCallsEnabled) {
    try {
      typedCalls = await analyzeTypedCalls(config.rootDir, files, sharedProject)
      timing.detectors['typed-calls'] = performance.now() - tTypedCalls
    } catch (err) {
      timing.detectors['typed-calls'] = performance.now() - tTypedCalls
      console.error(`  ✗ typed-calls failed: ${err}`)
    }
  }

  // ─── 5e. Cycles (structural map phase 1.3) ─────────────────────────
  // Tarjan SCC sur graphe combiné (import + event + queue + dynamic-load).
  // Désactivable via config.detectorOptions.cycles.enabled = false.

  const cyclesEnabled =
    !factsOnly &&
    ((config.detectorOptions?.['cycles']?.['enabled'] as boolean | undefined) ?? true)

  const tCycles = performance.now()
  let cycles: Awaited<ReturnType<typeof analyzeCycles>> | undefined
  if (cyclesEnabled) {
    try {
      const cycleOptions = config.detectorOptions?.['cycles'] ?? {}
      cycles = await analyzeCycles(
        config.rootDir,
        files,
        graph.getAllEdges(),
        sharedProject,
        {
          edgeTypes: cycleOptions['edgeTypes'] as any,
          gateNames: cycleOptions['gateNames'] as string[] | undefined,
        },
      )
      timing.detectors['cycles'] = performance.now() - tCycles
    } catch (err) {
      timing.detectors['cycles'] = performance.now() - tCycles
      console.error(`  ✗ cycles failed: ${err}`)
    }
  }

  // ─── 5f. Truth points (structural map phase 1.4) ───────────────────
  // Pour chaque concept de donnée partagée : canonical table + mirrors
  // (redis / memory) + writers / readers / exposed. Désactivable via
  // config.detectorOptions.truthPoints.enabled = false.

  const truthPointsEnabled =
    !factsOnly &&
    ((config.detectorOptions?.['truthPoints']?.['enabled'] as boolean | undefined) ?? true)

  const tTruthPoints = performance.now()
  let truthPoints: Awaited<ReturnType<typeof analyzeTruthPoints>> | undefined
  if (truthPointsEnabled) {
    try {
      const tpOptions = config.detectorOptions?.['truthPoints'] ?? {}
      truthPoints = await analyzeTruthPoints(
        config.rootDir,
        files,
        sharedProject,
        graph.getAllEdges(),
        {
          conceptAliases: tpOptions['conceptAliases'] as Record<string, string[]> | undefined,
          redisVarNames: tpOptions['redisVarNames'] as string[] | undefined,
          memoryCacheSuffixes: tpOptions['memoryCacheSuffixes'] as string[] | undefined,
          memoryCacheCtors: tpOptions['memoryCacheCtors'] as string[] | undefined,
          exposedPrefixes: tpOptions['exposedPrefixes'] as string[] | undefined,
        },
      )
      timing.detectors['truth-points'] = performance.now() - tTruthPoints
    } catch (err) {
      timing.detectors['truth-points'] = performance.now() - tTruthPoints
      console.error(`  ✗ truth-points failed: ${err}`)
    }
  }

  // ─── 5g. Data flows (structural map phase 1.5) ─────────────────────
  // Trajectoires entry-point → sinks via BFS sur typedCalls. Dépend de
  // typedCalls : si désactivé, data-flows skip.

  const dataFlowsEnabled =
    !factsOnly &&
    ((config.detectorOptions?.['dataFlows']?.['enabled'] as boolean | undefined) ?? true)

  const tDataFlows = performance.now()
  let dataFlows: Awaited<ReturnType<typeof analyzeDataFlows>> | undefined
  if (dataFlowsEnabled && typedCalls) {
    try {
      const dfOptions = config.detectorOptions?.['dataFlows'] ?? {}
      dataFlows = await analyzeDataFlows(
        config.rootDir,
        files,
        sharedProject,
        typedCalls,
        graph.getAllEdges(),
        {
          maxDepth: dfOptions['maxDepth'] as number | undefined,
          downstreamDepth: dfOptions['downstreamDepth'] as number | undefined,
          queryFnNames: dfOptions['queryFnNames'] as string[] | undefined,
          emitFnNames: dfOptions['emitFnNames'] as string[] | undefined,
          listenFnNames: dfOptions['listenFnNames'] as string[] | undefined,
          httpResponseFnNames: dfOptions['httpResponseFnNames'] as string[] | undefined,
          bullmqEnqueueFnNames: dfOptions['bullmqEnqueueFnNames'] as string[] | undefined,
          mcpToolsPathFragment: dfOptions['mcpToolsPathFragment'] as string | undefined,
        },
      )
      timing.detectors['data-flows'] = performance.now() - tDataFlows
    } catch (err) {
      timing.detectors['data-flows'] = performance.now() - tDataFlows
      console.error(`  ✗ data-flows failed: ${err}`)
    }
  }

  // ─── 5h. State machines (structural map phase 1.6) ─────────────────
  // Enums + type aliases avec suffixe *Status|*State|*Phase|*Stage + writes
  // (SQL SET / INSERT VALUES + object literals) + trigger (listener, route,
  // init). Désactivable via config.detectorOptions.stateMachines.enabled.

  const stateMachinesEnabled =
    !factsOnly &&
    ((config.detectorOptions?.['stateMachines']?.['enabled'] as boolean | undefined) ?? true)

  const tStateMachines = performance.now()
  let stateMachines: Awaited<ReturnType<typeof analyzeStateMachines>> | undefined
  if (stateMachinesEnabled) {
    try {
      const smOptions = config.detectorOptions?.['stateMachines'] ?? {}
      stateMachines = await analyzeStateMachines(
        config.rootDir,
        files,
        sharedProject,
        {
          suffixes: smOptions['suffixes'] as string[] | undefined,
          listenFnNames: smOptions['listenFnNames'] as string[] | undefined,
        },
      )
      timing.detectors['state-machines'] = performance.now() - tStateMachines
    } catch (err) {
      timing.detectors['state-machines'] = performance.now() - tStateMachines
      console.error(`  ✗ state-machines failed: ${err}`)
    }
  }

  // ─── 5i. Env usage (structural map phase 3.6 B.5) ──────────────────
  // `process.env.X` / `process.env['X']` → section envUsage (readers par
  // nom, marquage secret heuristique).

  const envUsageEnabled =
    (config.detectorOptions?.['envUsage']?.['enabled'] as boolean | undefined) ?? true

  const tEnvUsage = performance.now()
  let envUsage: Awaited<ReturnType<typeof analyzeEnvUsage>> | undefined
  if (envUsageEnabled) {
    try {
      const euOptions = config.detectorOptions?.['envUsage'] ?? {}
      envUsage = await analyzeEnvUsage(
        config.rootDir,
        files,
        sharedProject,
        {
          secretTokens: euOptions['secretTokens'] as string[] | undefined,
        },
      )
      timing.detectors['env-usage'] = performance.now() - tEnvUsage
    } catch (err) {
      timing.detectors['env-usage'] = performance.now() - tEnvUsage
      console.error(`  ✗ env-usage failed: ${err}`)
    }
  }

  // ─── 5j. Package deps hygiene (phase 3.8 #7) ───────────────────────
  // `package.json` declared vs observed imports → declared-unused / missing /
  // devOnly. Multi-manifest (chaque package.json découvert = scope propre).
  // Désactivable via config.detectorOptions.packageDeps.enabled = false.

  const packageDepsEnabled =
    !factsOnly &&
    ((config.detectorOptions?.['packageDeps']?.['enabled'] as boolean | undefined) ?? true)

  const tPackageDeps = performance.now()
  let packageDeps: Awaited<ReturnType<typeof analyzePackageDeps>> | undefined
  if (packageDepsEnabled) {
    try {
      const pdOptions = config.detectorOptions?.['packageDeps'] ?? {}
      packageDeps = await analyzePackageDeps(
        config.rootDir,
        files,
        sharedProject,
        {
          testPatterns: pdOptions['testPatterns'] as RegExp[] | undefined,
        },
      )
      timing.detectors['package-deps'] = performance.now() - tPackageDeps
    } catch (err) {
      timing.detectors['package-deps'] = performance.now() - tPackageDeps
      console.error(`  ✗ package-deps failed: ${err}`)
    }
  }

  // ─── 5k. Barrels (phase 3.8 #7) ────────────────────────────────────
  // Fichiers 100 % ré-exports → `lowValue` si consumers < threshold.

  const barrelsEnabled =
    !factsOnly &&
    ((config.detectorOptions?.['barrels']?.['enabled'] as boolean | undefined) ?? true)

  const tBarrels = performance.now()
  let barrels: Awaited<ReturnType<typeof analyzeBarrels>> | undefined
  if (barrelsEnabled) {
    try {
      const bOptions = config.detectorOptions?.['barrels'] ?? {}
      barrels = await analyzeBarrels(
        config.rootDir,
        files,
        sharedProject,
        {
          minConsumers: bOptions['minConsumers'] as number | undefined,
        },
      )
      timing.detectors['barrels'] = performance.now() - tBarrels
    } catch (err) {
      timing.detectors['barrels'] = performance.now() - tBarrels
      console.error(`  ✗ barrels failed: ${err}`)
    }
  }

  // ─── 5k-bis. Event emit sites (Datalog facts) ──────────────────────
  // Classification AST des appels emit({ type: ... }) — literal vs
  // eventConstRef vs dynamic. Source des facts `EmitsEventLiteral` /
  // `EmitsEventConst` pour les invariants ADR-017-style. Pas de coût ts-morph
  // additionnel car on réutilise le sharedProject.

  const eventEmitSitesEnabled =
    (config.detectorOptions?.['eventEmitSites']?.['enabled'] as boolean | undefined) ?? true

  const tEventEmitSites = performance.now()
  let eventEmitSites: Awaited<ReturnType<typeof analyzeEventEmitSites>> | undefined
  if (eventEmitSitesEnabled) {
    try {
      const eesOptions = config.detectorOptions?.['eventEmitSites'] ?? {}
      eventEmitSites = await analyzeEventEmitSites(
        config.rootDir,
        files,
        sharedProject,
        {
          emitFnNames: eesOptions['emitFnNames'] as string[] | undefined,
        },
      )
      timing.detectors['event-emit-sites'] = performance.now() - tEventEmitSites
    } catch (err) {
      timing.detectors['event-emit-sites'] = performance.now() - tEventEmitSites
      console.error(`  ✗ event-emit-sites failed: ${err}`)
    }
  }

  // ─── 5k-ter. OAuth scope literals (Datalog facts) ──────────────────
  // Strings hardcodées matchant le pattern d'URL de scope Google Auth.
  // Source du fact `OauthScopeLiteral` pour ADR-014.

  const oauthScopeLiteralsEnabled =
    (config.detectorOptions?.['oauthScopeLiterals']?.['enabled'] as boolean | undefined) ?? true

  const tOauthScope = performance.now()
  let oauthScopeLiterals: Awaited<ReturnType<typeof analyzeOauthScopeLiterals>> | undefined
  if (oauthScopeLiteralsEnabled) {
    try {
      const oslOptions = config.detectorOptions?.['oauthScopeLiterals'] ?? {}
      oauthScopeLiterals = await analyzeOauthScopeLiterals(
        config.rootDir,
        files,
        sharedProject,
        {
          scopePattern: oslOptions['scopePattern'] as RegExp | undefined,
        },
      )
      timing.detectors['oauth-scope-literals'] = performance.now() - tOauthScope
    } catch (err) {
      timing.detectors['oauth-scope-literals'] = performance.now() - tOauthScope
      console.error(`  ✗ oauth-scope-literals failed: ${err}`)
    }
  }

  // ─── 5l. Taint analysis (phase 3.8 #3) ─────────────────────────────
  // Flux source non-trusté → sink dangereux sans passage par un sanitizer.
  // Désactivé par default — activer via `detectorOptions.taint.enabled: true`
  // et fournir `detectorOptions.taint.rulesPath` ou laisser le default
  // `<rootDir>/taint-rules.json` / `<rootDir>/codegraph/taint-rules.json`.

  const taintEnabled =
    !factsOnly &&
    ((config.detectorOptions?.['taint']?.['enabled'] as boolean | undefined) ?? false)

  const tTaint = performance.now()
  let taintViolations: Awaited<ReturnType<typeof analyzeTaint>> | undefined
  if (taintEnabled) {
    try {
      const rulesPath = (config.detectorOptions?.['taint']?.['rulesPath'] as string | undefined)
        ?? await findTaintRules(config.rootDir)
      if (rulesPath) {
        const raw = JSON.parse(await fs.readFile(rulesPath, 'utf-8'))
        const rules: TaintRules = {
          sources: raw.sources ?? [],
          sinks: raw.sinks ?? [],
          sanitizers: raw.sanitizers ?? [],
        }
        taintViolations = await analyzeTaint(config.rootDir, files, sharedProject, rules)
      }
      timing.detectors['taint'] = performance.now() - tTaint
    } catch (err) {
      timing.detectors['taint'] = performance.now() - tTaint
      console.error(`  ✗ taint failed: ${err}`)
    }
  }

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
      snapshot.moduleMetrics = computeModuleMetrics(
        snapshot.nodes,
        snapshot.edges,
        {
          edgeTypesForCentrality: mmOptions['edgeTypesForCentrality'] as any,
          pagerankAlpha: mmOptions['pagerankAlpha'] as number | undefined,
          pagerankTolerance: mmOptions['pagerankTolerance'] as number | undefined,
        },
      )
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
      snapshot.componentMetrics = computeComponentMetrics(
        snapshot.nodes,
        snapshot.edges,
        {
          depth: cmOptions['depth'] as number | undefined,
          edgeTypes: cmOptions['edgeTypes'] as any,
          excludeComponents: cmOptions['excludeComponents'] as string[] | undefined,
        },
      )
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

  timing.total = performance.now() - t0

  return { snapshot, timing }
}

/**
 * Recherche `taint-rules.json` dans les emplacements conventionnels.
 * Retourne le chemin absolu du premier trouvé, ou null.
 */
async function findTaintRules(rootDir: string): Promise<string | null> {
  const candidates = [
    path.join(rootDir, 'taint-rules.json'),
    path.join(rootDir, 'codegraph', 'taint-rules.json'),
  ]
  for (const c of candidates) {
    try { await fs.access(c); return c } catch {}
  }
  return null
}

// ─── File Discovery ─────────────────────────────────────────────────────

async function discoverFiles(
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
