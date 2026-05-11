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
import { detectWorkspaces, buildWorkspaceEntryPointSet } from './workspaces.js'
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
import { BinShebangsDetector } from './detectors/bin-shebangs-detector.js'
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
// ADR-031 Phase 2 — eval-calls / crypto-algo / event-listener-sites :
// extractors ts-morph supprimés, Datalog est l'unique source.
// ADR-031 Phase 2 batch 4 — security-patterns / code-quality-patterns :
// extractors ts-morph supprimés, Datalog est l'unique source.
// ADR-031 Phase 2 batch 2 — function-complexity : extractor ts-morph supprimé, Datalog est l'unique source.
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
// ADR-031 Phase 2 batch 4 — hardcoded-secrets : extractor ts-morph supprimé, Datalog est l'unique source.
// ADR-031 Phase 2 batch 2 — boolean-params : extractor ts-morph supprimé, Datalog est l'unique source.
import { analyzeDeadCode, type DeadCodeFinding } from '../extractors/dead-code.js'
import { analyzeFloatingPromises, type FloatingPromiseSite } from '../extractors/floating-promises.js'
import { analyzeDeprecatedUsage, type DeprecatedDeclaration, type DeprecatedUsageSite } from '../extractors/deprecated-usage.js'
import { analyzeArticulationPoints, type ArticulationPoint } from '../extractors/articulation-points.js'
// ADR-031 Phase 2 batch 2 — constant-expressions : extractor ts-morph supprimé, Datalog est l'unique source.
import { importEslintViolations, type EslintViolation } from '../extractors/eslint-import.js'
import { findSqlNamingViolations, type SqlNamingViolation } from '../extractors/sql-naming.js'
import { findMigrationOrderViolations, type MigrationOrderViolation } from '../extractors/sql-migration-order.js'
// ADR-031 Phase 2 batch 4 — resource-balance : extractor ts-morph supprimé, Datalog est l'unique source.
// ADR-031 Phase 2 batch 3 — chaîne taint (taint-sinks / sanitizers /
// tainted-vars / arguments) : extractors ts-morph supprimés, Datalog est
// l'unique source. NB: `taint.ts` (cross-file analyzeTaint) reste actif.
// ADR-031 Phase 2 batch 2 — long-functions : extractor ts-morph supprimé, Datalog est l'unique source.
// ADR-031 Phase 2 — magic-numbers : extractor ts-morph supprimé, Datalog est l'unique source.
import { analyzeTestCoverage, type TestCoverageReport } from '../extractors/test-coverage.js'
import { analyzeCoChange, type CoChangePair } from '../extractors/co-change.js'
import {
  extractAllDocClaims,
  evaluateDocClaims,
  flattenDocClaims,
  type DocCrossCheckIndex,
} from '../extractors/doc-claims.js'
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
// ADR-031 Phase 2 batch 4 — wrappers Salsa code-quality-patterns / security-patterns retirés (cf. Datalog runner)
import { allDeadCode as incAllDeadCode } from '../incremental/dead-code.js'
import { allDeprecatedUsage as incAllDeprecatedUsage } from '../incremental/deprecated-usage.js'
// ADR-031 Phase 2 batch 2 — wrapper Salsa constant-expressions retiré (cf. Datalog runner)
// ADR-031 Phase 2 batch 4 — wrapper Salsa hardcoded-secrets retiré (cf. Datalog runner)
// ADR-031 Phase 2 — wrapper Salsa magic-numbers retiré (cf. Datalog runner)
// ADR-031 Phase 2 batch 4 — wrapper Salsa resource-balance retiré (cf. Datalog runner)
// ADR-031 Phase 2 batch 3 — wrappers Salsa chaîne taint retirés (cf. Datalog runner)
// ADR-031 Phase 2 — wrapper Salsa crypto-algo retiré (cf. Datalog runner)
// ADR-031 Phase 2 batch 2 — wrappers Salsa boolean-params / function-complexity retirés (cf. Datalog runner)
// ADR-031 Phase 2 — wrapper Salsa eval-calls retiré (cf. Datalog runner)
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
import { runDatalogShadow, logShadowReport } from '../datalog-detectors/shadow.js'
import { runDatalogDetectors, runDatalogDetectorsWithBundle, type DatalogDetectorResults } from '../datalog-detectors/runner.js'
import {
  buildSnapshotPatchFromDatalog,
  adaptDriftSignalsFromDatalog,
} from '../datalog-detectors/runner-adapter.js'
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
  // ADR-027 — relpaths des fichiers source effectivement analysés,
  // exposés pour permettre au CLI de calculer le `inputHash` Phase 2
  // sans re-walker le filesystem.
  files: readonly string[]
  // ADR-027 Phase 3 — bundle AST agrégé, exposé pour matérialiser le
  // content-addressed fact store. Présent quand `useDatalog` est on
  // (default pour incremental ; opt-in en cold via env / option).
  // `undefined` quand le pipeline Datalog n'a pas tourné (mode legacy).
  astFactsBundle?: import('../datalog-detectors/ast-facts/types.js').AstFactsBundle
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

  /**
   * Mode shadow ADR-026 phase A.1 : run le runner Datalog en parallèle
   * du legacy après que le snapshot soit finalisé. Compare les outputs
   * des 18 détecteurs portés (bench BIT-IDENTICAL) et logue les
   * divergences sans modifier le snapshot. Permet de valider la parité
   * sur des codebases réelles avant le swap A.2.
   *
   * Activable aussi via env var `LIBY_DATALOG_DETECTORS=1`.
   *
   * Coût : ~extractMs+evalMs du runner (ex: ~3s sur Sentinel 220 fichiers).
   * À utiliser en CI/dev, pas en pre-commit hot path.
   */
  datalogShadow?: boolean

  /**
   * Mode swap ADR-026 phase A.3+A.4 : remplace 21 détecteurs ts-morph
   * legacy par leur équivalent Datalog runner (1 AST walk + N rules).
   *
   * Phase E (v0.5.0) : par défaut **TRUE**. Pour rollback temporaire,
   * passer `useDatalog: false` ou env `LIBY_DATALOG_LEGACY=1`. Ce
   * legacy-mode sera deprecated en v0.6 et retiré en v1.0.
   *
   * 3 détecteurs hors-AST restent legacy par design (non portables) :
   *   - `state-machines` : multi-pass + async SQL scan
   *   - `drizzle-schema` : cross-file resolution
   *   - `bin-shebangs` : filesystem walk + JSON parse
   *
   * Mutuellement compatible avec `incremental: true` : le mode
   * incremental a priorité (Salsa cache > Datalog batch). Combiné avec
   * incremental → warm path < 200ms (cf. Phase C).
   */
  useDatalog?: boolean
}

export async function analyze(
  config: CodeGraphConfig,
  options: AnalyzeOptions = {},
): Promise<AnalyzeResult> {
  const factsOnly = options.factsOnly ?? false
  const incremental = options.incremental ?? false
  const skipPersistenceLoad = options.skipPersistenceLoad ?? false
  const skipPersistenceSave = options.skipPersistenceSave ?? false
  const datalogShadow = options.datalogShadow ?? (process.env['LIBY_DATALOG_DETECTORS'] === '1')
  // Phase E (v0.5+) : useDatalog est ON par défaut quand `incremental:
  // true` (watcher mode). Le default-on était initialement bloqué par
  // un bug de hash instable du runner Datalog (chaque run = facts
  // arrangés différemment → cache miss systématique). Cause root :
  // `discoverFiles` retournait un array d'ordre non-déterministe à cause
  // de `Promise.all(subdirs)` parallèle. Fix livré dans
  // `core/file-discovery.ts` (sort final). Datalog-runner warm passe
  // de 553ms → 23ms (24×).
  //
  // Override : `useDatalog: true` force partout, `useDatalog: false`
  // ou env `LIBY_DATALOG_LEGACY=1` force legacy. Legacy-mode sera
  // deprecated en v0.6 et retiré en v1.0.
  const useDatalog = options.useDatalog ?? (
    process.env['LIBY_DATALOG_DETECTORS_LIVE'] === '1' ||
    (incremental && process.env['LIBY_DATALOG_LEGACY'] !== '1')
  )
  // ADR-027 Phase 3 — capturé par runDeterministicDetectors quand
  // useDatalog est on (= bundle disponible). Reste undefined en mode
  // legacy / factsOnly — le CLI matérialise le fact store seulement
  // si le bundle est présent.
  let astFactsBundle: import('../datalog-detectors/ast-facts/types.js').AstFactsBundle | undefined
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
  await loadDiskCacheIfIncremental(config, incremental, skipPersistenceLoad)

  // ─── 3b. Pre-build shared Project (P4 — Sprint 6 etendu mode legacy) ──
  // Avant : seul le mode incremental pre-buildait le sharedProject. En
  // mode legacy, ts-imports creait son propre Project, le jetait, puis
  // resolveTsConfigAndSharedProject recreait un Project distinct → double
  // parse (cout ts-morph dupplique sur des projets de 200+ files).
  // Maintenant : pre-build dans les 2 modes, ts-imports reutilise via
  // setTsImportPrebuiltProject. Gain perf legacy ~30-40% sur gros repos.
  let preBuiltSharedProject: ReturnType<typeof createSharedProject> | null = null
  if (incremental) {
    preBuiltSharedProject = await prebuildSharedProjectIncremental(
      config, files, fileCache,
    )
  } else {
    preBuiltSharedProject = await prebuildSharedProjectLegacy(config, files)
  }

  // ─── 4. Run base detectors + build graph ───────────────────────────

  const graph = await runBaseDetectorsAndBuildGraph(
    config, files, fileCache, ctx, { incremental }, timing,
  )

  // ─── 5. tsconfig resolution + shared Project + Salsa async inputs ──

  const { tsConfigPath, sharedProject } = await resolveTsConfigAndSharedProject(
    config, files, { incremental, preBuiltSharedProject },
  )

  // ─── 5. Detectors via Registry (Phase B refactor terminé) ──────────
  // Tous les détecteurs Phase 5 sont migrés au pattern Detector/Registry.
  // L'ordre d'enregistrement détermine l'ordre d'exécution : typed-calls
  // doit tourner avant data-flows (qui le lit via ctx.results).

  const detectorRegistry = buildDetectorRegistry()

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
    // ADR-027 Phase 3 — capture l'AstFactsBundle pour matérialiser le
    // fact store (consommé par persistAnalyzeOutputs côté CLI).
    const detOut = await runDeterministicDetectors({
      config, files, readFile, sharedProject, snapshot, timing, incremental,
      useDatalog,
    })
    astFactsBundle = detOut.astFactsBundle
  } else {
    await runFactsOnlyTestCoverage(config, files, snapshot, timing)
  }

  // ─── 7. Post-snapshot metrics phase ────────────────────────────────
  // module-metrics, component-metrics, dsm. Tournent post-snapshot car
  // dépendent de snapshot.nodes + snapshot.edges (cf. helper).
  await runPostSnapshotMetrics(config, snapshot, timing, { factsOnly, incremental })

  // ─── 7b. Doc claims extraction (composite-doc-stale ADR-026) ──────
  // Lit les .md de docs/ + frontmatter YAML, cross-check contre les
  // .dl rules existantes, les fichiers source, et les ADRs. Émet des
  // facts DocClaim + DocStaleClaim consommés par composite-doc-stale.dl.
  // Pas dans factsOnly mode (output dégénéré).
  if (!factsOnly) {
    const tDoc = performance.now()
    try {
      await runDocClaimsExtraction(config.rootDir, snapshot)
    } catch (err) {
      console.error(`  ✗ doc-claims failed: ${err}`)
    } finally {
      timing.detectors['doc-claims'] = performance.now() - tDoc
    }
  }

  // ─── 8. Datalog shadow run (ADR-026 phase A.1) ─────────────────────
  // Compare runner Datalog vs legacy snapshot. Skip si factsOnly (snapshot
  // incomplet, comparaison aurait des faux ✗ partout).
  if (datalogShadow && !factsOnly) {
    const tShadow = performance.now()
    try {
      const report = await runDatalogShadow({
        project: sharedProject, files, rootDir: config.rootDir, snapshot,
      })
      logShadowReport(report)
    } catch (err) {
      console.error(`  ✗ datalog-shadow failed: ${err}`)
    } finally {
      timing.detectors['datalog-shadow'] = performance.now() - tShadow
    }
  }

  // ─── Persist disk cache (Sprint 7) ───────────────────────────────────
  await persistDiskCacheIfIncremental(config, incremental, skipPersistenceSave)

  timing.total = performance.now() - t0

  return { snapshot, timing, files, astFactsBundle }
}

/**
 * Si on a un .codegraph/salsa-cache.json valide, restaure les cells + mtimes
 * AVANT toute autre étape. Permet le warm cross-process via CLI : 2e
 * `codegraph analyze --incremental` benéficie du cache disque même dans
 * un nouveau process.
 *
 * Sprint 9 : skipPersistenceLoad permet au watcher de ne pas relire le
 * disque entre analyzes (la DB reste en RAM).
 */
async function loadDiskCacheIfIncremental(
  config: CodeGraphConfig,
  incremental: boolean,
  skipPersistenceLoad: boolean,
): Promise<void> {
  if (!incremental || skipPersistenceLoad) return
  try {
    const loaded = await incLoadPersistedCache(config.rootDir, incSharedDb)
    if (loaded) incLoadMtimeMap(loaded.mtimes)
  } catch {
    // Cache corrompu — on continue cold, save écrasera au final.
  }
}

/**
 * À la fin d'un run incremental, sauve cells + mtimes pour qu'un process
 * ultérieur (CLI) bénéficie du warm.
 *
 * Sprint 9 : skipPersistenceSave permet au watcher de ne pas écrire ~3 MB
 * à chaque change. Le caller du watcher save périodiquement ou au stop.
 */
async function persistDiskCacheIfIncremental(
  config: CodeGraphConfig,
  incremental: boolean,
  skipPersistenceSave: boolean,
): Promise<void> {
  if (!incremental || skipPersistenceSave) return
  try {
    await incSavePersistedCache(config.rootDir, incGetMtimeMap(), incSharedDb)
  } catch {
    // Échec de save = pas bloquant. Le run a réussi.
  }
}

/**
 * Always-run subset en mode factsOnly : test-coverage est cheap (import-based
 * mapping) ET load-bearing pour la rule composite-hub-untested (CI gate
 * datalog). Sans lui, tout fichier hub testé apparaît comme untested → faux
 * positifs bloquants au pre-commit. Cf. Sentinel pre-commit hook qui fait
 * `codegraph facts --regen` (mode factsOnly) puis exécute datalog-invariants
 * test : hub testé sans TestedFile → fail.
 */
async function runFactsOnlyTestCoverage(
  config: CodeGraphConfig,
  files: string[],
  snapshot: GraphSnapshot,
  timing: AnalyzeResult['timing'],
): Promise<void> {
  const tCovFO = performance.now()
  try {
    snapshot.testCoverage = await analyzeTestCoverage(config.rootDir, files, snapshot.edges)
  } catch (err) {
    console.error(`  ✗ test-coverage (factsOnly) failed: ${err}`)
  } finally {
    timing.detectors['test-coverage'] = performance.now() - tCovFO
  }
}

/**
 * Build le DetectorRegistry. L'ordre d'enregistrement détermine l'ordre
 * d'exécution : typed-calls doit tourner avant data-flows (qui le lit
 * via ctx.results).
 */
function buildDetectorRegistry(): DetectorRegistry {
  return new DetectorRegistry()
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
    .register(new BinShebangsDetector())
    .register(new BarrelsDetector())
    .register(new EventEmitSitesDetector())
    .register(new OauthScopeLiteralsDetector())
    .register(new TaintDetector())
    .register(new SqlSchemaDetector())
    .register(new DrizzleSchemaDetector())
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
  opts: { incremental: boolean },
  timing: AnalyzeResult['timing'],
): Promise<CodeGraph> {
  const { incremental } = opts
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
      // await-ok: ordre détecteurs requis (ts-imports avant data-flows etc.) — pas parallélisable
      const links = await detector.detect(ctx)
      allLinks.push(...links)
      timing.detectors[detector.name] = performance.now() - tDet
    } catch (err) {
      const elapsed = performance.now() - tDet
      timing.detectors[detector.name] = elapsed
      console.error(`  ✗ ${detector.name} failed (${elapsed.toFixed(0)}ms): ${err}`)
    }
  }

  // Reset le prebuilt apres consommation par ts-imports (mode incremental
  // ET mode legacy depuis P4) — evite les fuites de state entre runs si
  // analyze() est invoque plusieurs fois dans le meme process.
  setTsImportPrebuiltProject(null)

  const tGraph = performance.now()
  // Workspace entry-points : main/exports/types/bin de chaque package
  // declare dans pnpm-workspace.yaml / package.json#workspaces / lerna.json.
  // Sans ca, sur un monorepo, les `packages/<pkg>/src/index.ts` sont
  // classifies orphan car les imports `@scope/pkg` ne resolvent pas vers
  // le workspace local. Cf. OSS-AUDIT-2026-05-08 P2.1.
  const wsMap = await detectWorkspaces(config.rootDir)
  const workspaceEntryPoints = buildWorkspaceEntryPointSet(wsMap)
  const graph = new CodeGraph(config.rootDir, config.entryPoints, workspaceEntryPoints)
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
async function findTsConfigPath(config: CodeGraphConfig): Promise<string | undefined> {
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
      // await-ok: probe avec break sur premiere match, sequentiel requis
      await fs.access(candidate)
      return candidate
    } catch { /* probe: try next tsconfig location */ }
  }
  return undefined
}

async function feedActiveManifestsInput(rootDir: string, files: string[]): Promise<void> {
  const allManifests = await discoverPackageManifests(rootDir)
  if (allManifests.length === 0) {
    incSetInputIfChanged(incPackageManifests, 'all', [])
    return
  }
  allManifests.sort((a, b) => b.dir.length - a.dir.length)
  const scopeFileCount = new Map<string, number>()
  for (const m of allManifests) scopeFileCount.set(m.abs, 0)
  for (const rel of files) {
    const abs = path.join(rootDir, rel)
    const m = findClosestPackageManifest(abs, allManifests)
    if (m) scopeFileCount.set(m.abs, (scopeFileCount.get(m.abs) ?? 0) + 1)
  }
  const activeManifests = allManifests.filter((m) => (scopeFileCount.get(m.abs) ?? 0) > 0)
  incSetInputIfChanged(incPackageManifests, 'all', activeManifests)
}

async function feedSqlDefaultsInput(rootDir: string): Promise<void> {
  const sqlDefaultsBuffer: StateMachineWriteSignal[] = []
  try {
    const sqlFiles = await discoverSqlFilesForIncremental(rootDir, ['**/*.sql'])
    // Lit en parallele (I/O independantes), scan/push sequentiel apres.
    const sqlContents = await Promise.all(
      sqlFiles.map(async (sqlFile) => {
        try {
          const content = await fs.readFile(path.join(rootDir, sqlFile), 'utf-8')
          return { sqlFile, content }
        } catch { return null /* race delete, permissions — skip */ }
      }),
    )
    for (const entry of sqlContents) {
      if (!entry) continue
      scanSqlColumnDefaultsForIncremental(entry.content, entry.sqlFile, sqlDefaultsBuffer)
    }
  } catch { /* aucun SQL file dans ce projet — sqlDefaultsBuffer reste vide */ }
  incSetInputIfChanged(incSqlDefaults, 'all', sqlDefaultsBuffer)
}

async function resolveTsConfigAndSharedProject(
  config: CodeGraphConfig,
  files: string[],
  opts: { incremental: boolean; preBuiltSharedProject: ReturnType<typeof createSharedProject> | null },
): Promise<{
  tsConfigPath: string | undefined
  sharedProject: ReturnType<typeof createSharedProject>
}> {
  const { incremental, preBuiltSharedProject } = opts
  const tsConfigPath = await findTsConfigPath(config)

  let sharedProject: ReturnType<typeof createSharedProject>
  if (incremental) {
    sharedProject = preBuiltSharedProject!
    await feedActiveManifestsInput(config.rootDir, files)
    await feedSqlDefaultsInput(config.rootDir)
  } else if (preBuiltSharedProject) {
    // P4 : reuse le Project pre-build a la phase 3b (mode legacy etendu).
    sharedProject = preBuiltSharedProject
  } else {
    // Fallback : ancien comportement si pre-build a echoue.
    sharedProject = createSharedProject(config.rootDir, files, tsConfigPath)
  }

  return { tsConfigPath, sharedProject }
}

/**
 * Pre-build le sharedProject ts-morph en mode legacy (non-incremental).
 *
 * P4 mutualization (cf. OSS-AUDIT-2026-05-08) : sans pre-build,
 * `ts-imports` cree son propre Project, le jette, puis l'analyzer
 * recree un Project distinct via `createSharedProject` au moment de
 * `resolveTsConfigAndSharedProject` → double parse ts-morph (1.5-2s
 * sur Sentinel, 5s+ sur tanstack-query).
 *
 * Le pre-build expose le Project a ts-imports via `setTsImportPrebuilt
 * Project` ET le retourne pour reuse downstream (complexity, unused-
 * exports, taint, etc.).
 */
async function prebuildSharedProjectLegacy(
  config: CodeGraphConfig,
  files: string[],
): Promise<ReturnType<typeof createSharedProject>> {
  const tsConfigPath = await findTsConfigPath(config)
  const project = createSharedProject(config.rootDir, files, tsConfigPath)
  setTsImportPrebuiltProject(project)
  return project
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
interface FileStatEntry { f: string; absPath: string; mtime: number | undefined }

async function statFilesParallel(rootDir: string, files: string[]): Promise<FileStatEntry[]> {
  return Promise.all(
    files.map(async (f) => {
      const absPath = path.join(rootDir, f)
      try {
        const stat = await fs.stat(absPath)
        return { f, absPath, mtime: stat.mtimeMs }
      } catch { return { f, absPath, mtime: undefined as number | undefined } }
    }),
  )
}

/**
 * Filtre les files pour ne lire que ceux qui ont VRAIMENT change
 * (mtime ≠ cached) ou qui ne sont pas encore dans la cell. Le warm
 * path (rien change) ne fait QUE des stats — pas de readFile gaspille.
 */
function filterFilesToRead(stats: FileStatEntry[]): FileStatEntry[] {
  const toRead: FileStatEntry[] = []
  for (const entry of stats) {
    const { f, mtime } = entry
    const cachedMtime = incGetCachedMtime(f)
    const cellExists = incFileContent.has(f)
    if (mtime !== undefined && cachedMtime === mtime && cellExists) continue
    toRead.push(entry)
  }
  return toRead
}

async function readAndCacheFiles(toRead: FileStatEntry[], fileCache: Map<string, string>): Promise<void> {
  const reads = await Promise.all(
    toRead.map(async ({ f, absPath, mtime }) => {
      let content = fileCache.get(f)
      if (content === undefined) {
        try { content = await fs.readFile(absPath, 'utf-8') } catch { content = '' }
      }
      return { f, mtime, content }
    }),
  )
  for (const { f, mtime, content } of reads) {
    fileCache.set(f, content)
    incFileContent.set(f, content)
    if (mtime !== undefined) incSetCachedMtime(f, mtime)
  }
}

async function prebuildSharedProjectIncremental(
  config: CodeGraphConfig,
  files: string[],
  fileCache: Map<string, string>,
): Promise<ReturnType<typeof createSharedProject>> {
  const earlyTsConfigPath = await findTsConfigPath(config)

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

  // Two-phase parallelization : (1) stat en parallele pour identifier les
  // fichiers qui ont VRAIMENT change (mtime ≠ cached), (2) read seulement
  // ceux-la en parallele. Cold path : full read parallele.
  const stats = await statFilesParallel(config.rootDir, files)
  const toRead = filterFilesToRead(stats)
  await readAndCacheFiles(toRead, fileCache)
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
/**
 * Contexte partagé passé à chaque phase. Évite de propager 7 paramètres
 * répétés au call-site de chaque détecteur.
 */
interface DetectorPhaseContext {
  config: CodeGraphConfig
  files: string[]
  readFile: (relativePath: string) => Promise<string>
  sharedProject: ReturnType<typeof createSharedProject>
  snapshot: GraphSnapshot
  timing: AnalyzeResult['timing']
  incremental: boolean
  /**
   * ADR-026 phase A.3 : si non-null, contient les outputs des 18 fields
   * trivial-compat du runner Datalog. Les phases 1-6 branchent dessus
   * pour skipper le legacy/extracteur ts-morph quand `useDatalog` est
   * actif. Salsa cache (incremental mode) reste prioritaire — cascade :
   *   incremental ? salsa : datalogPatch ? datalogPatch.X : legacy
   */
  datalogPatch: ReturnType<typeof buildSnapshotPatchFromDatalog> | null
  /**
   * ADR-026 phase A.3 : raw output du runner. Phase 2 le consomme pour
   * reconstruire `driftSignals` (qui dépend de `phase1.todos` non
   * disponibles au moment du pre-compute).
   */
  datalogResults: DatalogDetectorResults | null
}

interface RunDetectorsArgs {
  config: CodeGraphConfig
  files: string[]
  readFile: (relativePath: string) => Promise<string>
  sharedProject: ReturnType<typeof createSharedProject>
  snapshot: GraphSnapshot
  timing: AnalyzeResult['timing']
  incremental?: boolean
  useDatalog?: boolean
}

async function runDeterministicDetectors(
  args: RunDetectorsArgs,
): Promise<{ astFactsBundle?: import('../datalog-detectors/ast-facts/types.js').AstFactsBundle }> {
  const { config, files, readFile, sharedProject, snapshot, timing } = args
  const incremental = args.incremental ?? false
  const useDatalog = args.useDatalog ?? false

  // ADR-026 phase A.3 + C : pre-compute Datalog runner UNE FOIS pour les
  // phases 1-6. Si `incremental` est aussi actif, le runner utilise le
  // cache Salsa per-file (`incremental/datalog-ast-facts.ts`) — warm
  // path < 200ms au lieu de ~3s sur Sentinel.
  let datalogPatch: ReturnType<typeof buildSnapshotPatchFromDatalog> | null = null
  let datalogResults: DatalogDetectorResults | null = null
  // ADR-027 Phase 3 — capture l'AstFactsBundle pour matérialiser le
  // content-addressed fact store. Le bundle existe seulement quand le
  // runner Datalog tourne. En legacy mode, le fact store reste vide
  // (le CLI logue un warning si l'utilisateur attendait le store).
  let astFactsBundle: import('../datalog-detectors/ast-facts/types.js').AstFactsBundle | undefined
  if (useDatalog) {
    const tDl = performance.now()
    try {
      const dlOut = await runDatalogDetectorsWithBundle({
        project: sharedProject, files, rootDir: config.rootDir,
        incremental,  // active le cache Salsa per-file (Phase C.1)
      })
      datalogResults = dlOut.results
      astFactsBundle = dlOut.bundle
      datalogPatch = buildSnapshotPatchFromDatalog(datalogResults)

      // ADR-031 Phase 1 — override des 3 fields déjà patchés par
      // DetectorRegistry. Les détecteurs ts-morph (env-usage, barrels,
      // event-emit-sites) tournent toujours via le registry mais leurs
      // outputs sont remplacés par ceux du runner. Les 17 autres fields
      // portés sont branchés en cascade `datalogPatch ? dl.X : legacy`
      // dans phases 1-6 ci-dessous. La parité BIT-IDENTICAL des 20 fields
      // est verrouillée en CI par datalog-legacy-parity.test.ts
      // (canary fixture). Phase 2 retirera les détecteurs ts-morph
      // legacy correspondants.
      snapshot.envUsage = datalogPatch.envUsage
      snapshot.barrels = datalogPatch.barrels
      snapshot.eventEmitSites = datalogPatch.eventEmitSites
    } catch (err) {
      console.error(`  ✗ datalog-runner (useDatalog) failed: ${err}`)
    } finally {
      timing.detectors['datalog-runner'] = performance.now() - tDl
    }
  }

  const ctx: DetectorPhaseContext = {
    config, files, readFile, sharedProject, snapshot, timing, incremental,
    datalogPatch, datalogResults,
  }

  const phase1 = await runPhase1IndependentDetectors(ctx)
  const phase2 = await runPhase2Phase1Dependent(ctx, phase1.todos)
  // Phase 3 — cross-discipline orchestrator : 11 disciplines mathématiques
  // (extrait dans extractors/_shared/cross-discipline-orchestrator.ts).
  const _crossDisciplineDetector = new CrossDisciplineDetector()
  void _crossDisciplineDetector  // marker : pattern POC valid
  const cross = await runCrossDisciplineDetectors({
    rootDir: config.rootDir,
    files, sharedProject, snapshot,
    coChangePairs: phase1.coChangePairs,
    timing,
    incremental: ctx.incremental,
  })
  const phase4 = await runPhase4SecurityAndQuality(ctx)
  const phase5 = await runPhase5SqlAndResource(ctx)
  const phase6 = await runPhase6TaintChain(ctx)

  // Patch snapshot avec tous les results (assignation conditionnelle).
  assignIfDefined(snapshot, {
    ...phase1, ...phase2, ...phase4, ...phase5, ...phase6,
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
  })
  return { astFactsBundle }
}

/**
 * Phase 1 — détecteurs indépendants sans dep sur le snapshot finalisé ou
 * d'autres détecteurs. Tournent en premier ; leurs résultats alimentent
 * Phase 2 + cross-discipline.
 */
async function runPhase1IndependentDetectors(ctx: DetectorPhaseContext) {
  const { config, files, readFile, sharedProject, snapshot, timing, incremental, datalogPatch } = ctx

  const todos = await runDetectorTimed(timing, 'todos',
    () => analyzeTodos(config.rootDir, files, readFile))
  // ADR-026 A.3 : long-functions Datalog filtre déjà loc≥100 (cf. rules/
  // index.ts) — comportement identique au consumer-side qui lit ce field.
  // ADR-031 Phase 2 batch 2 — Datalog seul chemin. useDatalog=false → undefined.
  const longFunctions = await runDetectorTimed(timing, 'long-functions',
    () => Promise.resolve(datalogPatch?.longFunctions))
  // ADR-031 Phase 2 — Datalog seul chemin. useDatalog=false → field undefined.
  const magicNumbers = await runDetectorTimed(timing, 'magic-numbers',
    () => Promise.resolve(datalogPatch?.magicNumbers))
  const testCoverage = await runDetectorTimed(timing, 'test-coverage',
    () => analyzeTestCoverage(config.rootDir, files, snapshot.edges))
  const coChangePairs = await runDetectorTimed(timing, 'co-change',
    () => {
      const knownFilesArr = snapshot.nodes
        .filter((n) => n.type === 'file').map((n) => n.id).sort()
      if (incremental) {
        // Salsa-iso : keying sur (gitHead, knownFiles). Cache hit warm
        // tant que HEAD n'a pas bougé et knownFiles est stable.
        incSetInputIfChanged(incCoChangeGitHead, 'all', getGitHead(config.rootDir))
        incSetInputIfChanged(incCoChangeKnownFiles, 'all', knownFilesArr)
        return Promise.resolve(incAllCoChangePairs.get('all'))
      }
      return analyzeCoChange(config.rootDir, { knownFiles: new Set(knownFilesArr) })
    })

  return { todos, longFunctions, magicNumbers, testCoverage, coChangePairs }
}

/**
 * Phase 2 — détecteurs dépendants de Phase 1 (drift-patterns dépend de
 * todos pour Pattern 3 todo-no-owner).
 */
async function runPhase2Phase1Dependent(
  ctx: DetectorPhaseContext,
  todos: TodoMarker[] | undefined,
) {
  const { config, files, sharedProject, timing, incremental, datalogPatch, datalogResults } = ctx

  const driftSignals = await runDetectorTimed(timing, 'drift-patterns',
    () => {
      if (incremental) {
        // Salsa cache UNIQUEMENT les patterns 1+2+4+5 (per-file AST).
        // Pattern 3 (todo-no-owner) dépend de snapshot.todos — on l'ajoute
        // hors-cache puis on re-trie globalement.
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
      // ADR-026 A.3 : Datalog runner = 4 AST sub-arrays plats. Adapter
      // reconstruit DriftSignal[] et merge le 5e kind todo-no-owner.
      if (datalogResults) {
        return Promise.resolve(adaptDriftSignalsFromDatalog(
          datalogResults.driftPatterns, todos, config.rootDir,
        ))
      }
      return analyzeDriftPatterns(config.rootDir, files, sharedProject, todos)
    })
  // ADR-031 Phase 2 — Datalog seul chemin. useDatalog=false → field undefined.
  const evalCalls = await runDetectorTimed(timing, 'eval-calls',
    () => Promise.resolve(datalogPatch?.evalCalls))
  const cryptoCalls = await runDetectorTimed(timing, 'crypto-algo',
    () => Promise.resolve(datalogPatch?.cryptoCalls))
  // ADR-031 Phase 2 batch 4 — Datalog seul chemin. useDatalog=false → undefined.
  const securityPatterns = await runDetectorTimed(timing, 'security-patterns',
    () => Promise.resolve(datalogPatch?.securityPatterns))
  // ADR-031 Phase 2 — Datalog seul chemin. useDatalog=false → field undefined.
  const eventListenerSites = await runDetectorTimed(timing, 'event-listener-sites',
    () => Promise.resolve(datalogPatch?.eventListenerSites))
  // ADR-031 Phase 2 batch 4 — Datalog seul chemin. useDatalog=false → undefined.
  const codeQualityPatterns = await runDetectorTimed(timing, 'code-quality-patterns',
    () => Promise.resolve(datalogPatch?.codeQualityPatterns))
  // ADR-031 Phase 2 batch 2 — Datalog seul chemin. useDatalog=false → undefined.
  const functionComplexity = await runDetectorTimed(timing, 'function-complexity',
    () => Promise.resolve(datalogPatch?.functionComplexity))

  return {
    driftSignals, evalCalls, cryptoCalls, securityPatterns, eventListenerSites,
    codeQualityPatterns, functionComplexity,
  }
}

/**
 * Phase 4 — security + quality detectors indépendants. Inclut
 * articulation-points (graph metric sur snapshot finalisé) et
 * constant-expressions (simplification symbolique).
 */
async function runPhase4SecurityAndQuality(ctx: DetectorPhaseContext) {
  const { config, files, sharedProject, snapshot, timing, incremental, datalogPatch } = ctx

  // ADR-031 Phase 2 batch 4 — Datalog seul chemin. useDatalog=false → undefined.
  const hardcodedSecrets = await runDetectorTimed(timing, 'hardcoded-secrets',
    () => Promise.resolve(datalogPatch?.hardcodedSecrets))
  // ADR-031 Phase 2 batch 2 — Datalog seul chemin. useDatalog=false → undefined.
  const booleanParams = await runDetectorTimed(timing, 'boolean-params',
    () => Promise.resolve(datalogPatch?.booleanParams))
  // dead-code : Phase A.4.2 — runner couvre désormais les 6 kinds via
  // délégation `extractDeadCodeFileBundle` dans le visitor (parité 100%).
  const deadCode = await runDetectorTimed(timing, 'dead-code',
    () => incremental
      ? Promise.resolve(incAllDeadCode.get('all'))
      : datalogPatch
        ? Promise.resolve(datalogPatch.deadCode)
        : analyzeDeadCode(config.rootDir, files, sharedProject))
  // floating-promises : dep sur snapshot.typedCalls (Phase 5 graph build).
  const floatingPromises = await runDetectorTimed(timing, 'floating-promises',
    () => analyzeFloatingPromises(config.rootDir, files, sharedProject, snapshot.typedCalls))
  const deprecatedUsage = await runDetectorTimed(timing, 'deprecated-usage',
    () => incremental
      ? Promise.resolve(incAllDeprecatedUsage.get('all'))
      : analyzeDeprecatedUsage(config.rootDir, files, sharedProject))
  const articulationPoints = await runDetectorTimed(timing, 'articulation-points',
    () => analyzeArticulationPoints(snapshot))
  // Constant expressions — patterns simplification symbolique.
  // ADR-031 Phase 2 batch 2 — Datalog seul chemin. useDatalog=false → undefined.
  const constantExpressions = await runDetectorTimed(timing, 'constant-expressions',
    () => Promise.resolve(datalogPatch?.constantExpressions))
  // ESLint ingester — read .codegraph/eslint.json if user provided it.
  const eslintViolations = await runDetectorTimed(timing, 'eslint-import',
    () => importEslintViolations(config.rootDir))

  return {
    hardcodedSecrets, booleanParams, deadCode, floatingPromises, deprecatedUsage,
    articulationPoints, constantExpressions, eslintViolations,
  }
}

/**
 * Phase 5 — SQL detectors gated sur snapshot.sqlSchema + resource-balance.
 * Si pas de schema SQL détecté, sql-naming/migration-order retournent
 * undefined → snapshot fields restent non-set.
 */
async function runPhase5SqlAndResource(ctx: DetectorPhaseContext) {
  const { config, files, sharedProject, snapshot, timing, incremental, datalogPatch } = ctx

  const sqlNamingViolations = await runDetectorTimed(timing, 'sql-naming',
    async () => snapshot.sqlSchema ? findSqlNamingViolations(snapshot.sqlSchema) : undefined)
  const sqlMigrationOrderViolations = await runDetectorTimed(timing, 'sql-migration-order',
    async () => snapshot.sqlSchema ? findMigrationOrderViolations(snapshot.sqlSchema) : undefined)
  // ADR-031 Phase 2 batch 4 — Datalog seul chemin. useDatalog=false → undefined.
  const resourceImbalances = await runDetectorTimed(timing, 'resource-balance',
    () => Promise.resolve(datalogPatch?.resourceImbalances))

  return { sqlNamingViolations, sqlMigrationOrderViolations, resourceImbalances }
}

/**
 * Phase 6 — chaîne taint analysis : sinks → sanitizers → tainted-vars
 * → arguments. Détecteurs indépendants dans l'exécution (pas de dep
 * runtime), mais les rules Datalog en aval consomment les 4 facts.
 */
async function runPhase6TaintChain(ctx: DetectorPhaseContext) {
  const { timing, datalogPatch } = ctx

  // ADR-031 Phase 2 batch 3 — Datalog seul chemin pour la chaîne taint.
  // useDatalog=false → 4 fields undefined.
  const taintSinks = await runDetectorTimed(timing, 'taint-sinks',
    () => Promise.resolve(datalogPatch?.taintSinks))
  const sanitizerCalls = await runDetectorTimed(timing, 'sanitizers',
    () => Promise.resolve(datalogPatch?.sanitizerCalls))
  const taintedVars = await runDetectorTimed(timing, 'tainted-vars',
    () => Promise.resolve(datalogPatch?.taintedVars))
  const argumentsFacts = await runDetectorTimed(timing, 'arguments',
    () => Promise.resolve(datalogPatch?.argumentsFacts))

  return { taintSinks, sanitizerCalls, taintedVars, argumentsFacts }
}

// ADR-031 Phase 2 batch 2 — `analyzeConstantExpressionsBatch` retiré
// (Datalog runner remplace l'agrégat per-file ts-morph).

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
    ['bin-shebangs', 'binShebangIssues'],
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
/**
 * Wrap try/catch + timing tracking pour un detector post-snapshot.
 * Sans helper, chaque appel duplique 5 lignes (timer start, try/catch,
 * timing assign dans les 2 branches).
 */
interface MetricStepArgs {
  name: string
  enabled: boolean
  timing: AnalyzeResult['timing']
  fn: () => void | Promise<void>
}

async function runMetricStep(args: MetricStepArgs): Promise<void> {
  if (!args.enabled) return
  const t = performance.now()
  try {
    await args.fn()
    args.timing.detectors[args.name] = performance.now() - t
  } catch (err) {
    args.timing.detectors[args.name] = performance.now() - t
    console.error(`  ✗ ${args.name} failed: ${err}`)
  }
}

interface MetricRunArgs {
  config: CodeGraphConfig
  snapshot: GraphSnapshot
  incremental: boolean
}

function runModuleMetricsStep(args: MetricRunArgs): void {
  const { config, snapshot, incremental } = args
  const mmOptions = config.detectorOptions?.['moduleMetrics'] ?? {}
  if (incremental) {
    incSetInputIfChanged(incGraphNodes, 'all', snapshot.nodes)
    incSetInputIfChanged(incGraphEdgesForMetrics, 'all', snapshot.edges)
    snapshot.moduleMetrics = incAllModuleMetrics.get('all')
  } else {
    snapshot.moduleMetrics = computeModuleMetrics(snapshot.nodes, snapshot.edges, {
      edgeTypesForCentrality: mmOptions['edgeTypesForCentrality'] as any,
      pagerankAlpha: mmOptions['pagerankAlpha'] as number | undefined,
      pagerankTolerance: mmOptions['pagerankTolerance'] as number | undefined,
    })
  }
}

function runComponentMetricsStep(args: MetricRunArgs): void {
  const { config, snapshot, incremental } = args
  const cmOptions = config.detectorOptions?.['componentMetrics'] ?? {}
  if (incremental) {
    if (!incGraphNodes.has('all')) incSetInputIfChanged(incGraphNodes, 'all', snapshot.nodes)
    if (!incGraphEdgesForMetrics.has('all')) incSetInputIfChanged(incGraphEdgesForMetrics, 'all', snapshot.edges)
    snapshot.componentMetrics = incAllComponentMetrics.get('all')
  } else {
    snapshot.componentMetrics = computeComponentMetrics(snapshot.nodes, snapshot.edges, {
      depth: cmOptions['depth'] as number | undefined,
      edgeTypes: cmOptions['edgeTypes'] as any,
      excludeComponents: cmOptions['excludeComponents'] as string[] | undefined,
    })
  }
}

function runDsmStep(config: CodeGraphConfig, snapshot: GraphSnapshot): void {
  const dsmOptions = config.detectorOptions?.['dsm'] ?? {}
  const depth = (dsmOptions['depth'] as number | undefined) ?? 3
  const fileNodes = snapshot.nodes.filter((n) => n.type === 'file').map((n) => n.id)
  const importEdges = snapshot.edges
    .filter((e) => e.type === 'import')
    .map((e) => ({ from: e.from, to: e.to }))
  const agg = aggregateByContainer(fileNodes, importEdges, depth)
  snapshot.dsm = computeDsm(agg.nodes, agg.edges)
}

async function runPostSnapshotMetrics(
  config: CodeGraphConfig,
  snapshot: GraphSnapshot,
  timing: AnalyzeResult['timing'],
  options: { factsOnly: boolean; incremental: boolean },
): Promise<void> {
  const { factsOnly, incremental } = options
  const opts = config.detectorOptions

  await runMetricStep({
    name: 'module-metrics',
    enabled: (opts?.['moduleMetrics']?.['enabled'] as boolean | undefined) ?? true,
    timing,
    fn: () => runModuleMetricsStep({ config, snapshot, incremental }),
  })

  await runMetricStep({
    name: 'component-metrics',
    enabled: !factsOnly &&
      ((opts?.['componentMetrics']?.['enabled'] as boolean | undefined) ?? true),
    timing,
    fn: () => runComponentMetricsStep({ config, snapshot, incremental }),
  })

  await runMetricStep({
    name: 'dsm',
    enabled: !factsOnly &&
      ((opts?.['dsm']?.['enabled'] as boolean | undefined) ?? true),
    timing,
    fn: () => runDsmStep(config, snapshot),
  })
}

/**
 * Doc claims extraction — scan docs/*.md, parse frontmatter YAML +
 * inline mentions, cross-check contre les artefacts du repo (rules .dl,
 * fichiers source, ADRs). Patche le snapshot avec `docClaims` et
 * `docStaleClaims` qui seront émis comme facts par `facts/index.ts`.
 *
 * Build l'index local (dlRules, files, adrs) à partir du filesystem +
 * du snapshot — pas de cache Salsa pour ce détecteur (les .md changent
 * rarement et le scan est rapide, < 50ms typiquement).
 *
 * Failure mode : si l'extraction échoue (perms, fs error), on log et on
 * laisse les champs undefined. Le snapshot reste valide. Les rules
 * `composite-doc-stale.dl` deviennent silencieusement no-op.
 */
async function runDocClaimsExtraction(
  rootDir: string,
  snapshot: GraphSnapshot,
): Promise<void> {
  const bundles = await extractAllDocClaims(rootDir)

  // Build cross-check index depuis le filesystem (pas snapshot.nodes —
  // celui-ci exclut .test.ts et scripts/ par design, ce qui produit des
  // faux positifs si un doc référence un test ou un script).
  // - dlRules : scan des .dl files dans le repo
  // - files   : scan filesystem complet (TS/JS/MJS, hors node_modules/dist)
  // - adrs    : scan de docs/adr/NNN-*.md
  const index: DocCrossCheckIndex = {
    dlRules: new Set(),
    files: new Set(),
    adrs: new Set(),
  }
  await scanDlAndAdrIds(rootDir, index)

  const stale = evaluateDocClaims(bundles, index)
  const all = flattenDocClaims(bundles)

  snapshot.docClaims = all.map((c) => ({
    file: c.file, line: c.line, kind: c.kind, target: c.target,
  }))
  snapshot.docStaleClaims = stale.map((s) => ({
    file: s.file, line: s.line, kind: s.kind, target: s.target, issue: s.issue,
  }))
}

/**
 * Walk filesystem pour peupler les 3 sets du `DocCrossCheckIndex` :
 *   - `dlRules` : basenames des `.dl` (ex: `composite-X`)
 *   - `files`   : paths relatifs des fichiers source/tests/scripts
 *                 (.ts, .tsx, .mjs, .js) — couvre plus large que
 *                 `snapshot.nodes` (qui exclut tests + scripts)
 *   - `adrs`    : IDs ADR-NNN depuis docs/adr/NNN-*.md
 *
 * Skip node_modules / dist. Walk unique pour les 3 indexes (1 traversée
 * filesystem au lieu de 3).
 */
async function scanDlAndAdrIds(rootDir: string, index: DocCrossCheckIndex): Promise<void> {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    // Sépare files (sync) et subdirs (async parallèle) pour éviter
    // l'await-in-loop. Les sous-dossiers sont indépendants : Promise.all
    // donne un walk concurrent au lieu de séquentiel.
    const subdirs: string[] = []
    for (const entry of entries) {
      if (entry.name.startsWith('.git') || entry.name === 'node_modules' || entry.name === 'dist') {
        continue
      }
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        subdirs.push(full)
        continue
      }
      if (!entry.isFile()) continue

      const rel = path.relative(rootDir, full)
      if (entry.name.endsWith('.dl')) {
        index.dlRules.add(entry.name.replace(/\.dl$/, ''))
      }
      // Source / test / script files — pour cross-check des file-ref
      // mentions dans les docs. Inclut tests + scripts (vs snapshot.nodes
      // qui les exclut par design).
      if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) {
        index.files.add(rel)
      }
      if (rel.startsWith('docs/adr/')) {
        const m = entry.name.match(/^(\d{3})-/)
        if (m) index.adrs.add(`ADR-${m[1]}`)
      }
    }
    await Promise.all(subdirs.map(walk))
  }
  await walk(rootDir)
}

// ─── File Discovery ─────────────────────────────────────────────────────
// Extrait dans `core/file-discovery.ts` (refactor god-file 2026-05).
// Re-export pour préserver l'API publique.
export { discoverFiles } from './file-discovery.js'
