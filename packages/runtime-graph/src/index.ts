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
