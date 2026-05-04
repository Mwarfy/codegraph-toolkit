/**
 * @liby-tools/runtime-graph — public API
 *
 * Phase α (alpha.1) — runtime observability framework with datalog query language.
 * Captures actual execution graph via OpenTelemetry, joins with codegraph
 * statique facts, runs datalog rules to surface dead handlers, dead routes,
 * runtime drift, hot paths untested, stale queries.
 *
 * The OSS alternative to Datadog Live Code Coverage and JFrog X-Ray.
 *
 * Usage as library :
 *   import { attachRuntimeCapture, aggregateSpans, exportFactsRuntime } from '@liby-tools/runtime-graph'
 *
 * Usage as CLI :
 *   npx liby-runtime-graph run --duration 300 --base-url http://localhost:3000
 */

export { attachRuntimeCapture, getActiveCapture } from './capture/otel-attach.js'
export type { AttachOptions, CaptureHandle } from './capture/otel-attach.js'

export { aggregateSpans } from './capture/span-aggregator.js'

export { exportFactsRuntime } from './facts/exporter.js'
export type { ExportOptions, ExportResult } from './facts/exporter.js'

export { syntheticDriver } from './drivers/synthetic.js'
export { replayTestsDriver, importBootstrapFacts } from './drivers/replay-tests.js'
export { chaosDriver } from './drivers/chaos.js'

export { discoverExpressRoutes } from './adapters/frameworks/express.js'
export type { ExpressLikeApp, DiscoveredRoute } from './adapters/frameworks/express.js'

export { loadConfig, defineConfig } from './core/config-loader.js'
export type { LoadedConfig } from './core/config-loader.js'

// Phase γ — runtime mathematical disciplines
export {
  hammingStaticRuntime,
  informationBottleneckRuntime,
  newmanGirvanRuntime,
  lyapunovRuntime,
  computeAllDisciplines,
} from './metrics/runtime-disciplines.js'

// CPU profile capture (option A — V8 sampling, ~5-10% overhead)
export { startCpuProfile, aggregateProfile } from './capture/cpu-profile.js'
export type { CpuProfile, CpuProfileNode, CpuProfileHandle, AggregateOptions, AggregateResult } from './capture/cpu-profile.js'

// Function wrap via iitm (option C — exact, ~30-50% overhead, dev-only)
export { attachFnWrap } from './capture/fn-wrap.js'
export type { FnWrapOptions } from './capture/fn-wrap.js'

// Math optim suggester — Lyapunov / IB / variance heuristics
export { suggestOptimizations, renderSuggestionsMarkdown } from './optim/suggest.js'
export type { OptimSuggestOptions, OptimCandidate, OptimSuggestion } from './optim/suggest.js'

// Static↔runtime divergence — KL divergence (info theory) + Pareto + coverage drift
export { analyzeDivergence, renderDivergenceMarkdown } from './optim/divergence.js'
export type {
  DivergenceOptions,
  DivergenceResult,
  FileDivergence,
  ParetoResult,
  CoverageDrift,
} from './optim/divergence.js'

// Hitting time — Markov chain blast radius (Kemeny-Snell)
export { hittingTimeFrom, renderHittingTimeMarkdown } from './optim/hitting-time.js'
export type { HittingTimeOptions, HittingTimeRow, ImportEdge } from './optim/hitting-time.js'

// Wasserstein W₁ — distribution shift entre 2 runtime profiles (Monge-Kantorovich)
export { wassersteinDistance, renderWassersteinMarkdown } from './optim/wasserstein.js'
export type {
  WassersteinOptions,
  WassersteinResult,
  DistributionRow,
  MoverRow,
} from './optim/wasserstein.js'

// Forman-Ricci curvature — bottlenecks topologiques (geometry of graphs)
export { computeRicciCurvature, renderRicciMarkdown } from './optim/ricci-curvature.js'
export type { RicciOptions, RicciCurvatureRow, RicciEdge } from './optim/ricci-curvature.js'

// Submodular test selection — Nemhauser-Wolsey-Fisher greedy
export { selectTestsGreedy, renderSubmodularMarkdown } from './optim/submodular-tests.js'
export type {
  SubmodularOptions,
  TestRecommendation,
  CoverageEdge,
  FileWeight,
} from './optim/submodular-tests.js'

// Causal discovery — DAG drivers via co-change + temporal precedence (PC-inspired)
export { discoverCausalEdges, renderCausalMarkdown } from './optim/causal-discovery.js'
export type {
  CausalDiscoveryOptions,
  CausalEdge,
  CommitLog,
} from './optim/causal-discovery.js'
export type {
  StaticCallEdge,
  InformationBottleneckRuntimeFact,
  NewmanGirvanRuntimeFact,
  LyapunovRuntimeFact,
  AllDisciplinesResult,
} from './metrics/runtime-disciplines.js'
export { exportDisciplineFacts } from './facts/discipline-exporter.js'

export type {
  Driver,
  DriverRunOptions,
  DriverRunResult,
  RuntimeGraphConfig,
  RuntimeSnapshot,
  SymbolTouchedRuntimeFact,
  HttpRouteHitFact,
  DbQueryExecutedFact,
  RedisOpExecutedFact,
  EventEmittedAtRuntimeFact,
  CallEdgeRuntimeFact,
  RuntimeRunMetaFact,
} from './core/types.js'

export { RuntimeGraphError } from './core/types.js'
