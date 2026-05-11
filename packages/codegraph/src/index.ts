// ADR-032
// @liby-tools/codegraph — public API surface (cross-package barrel)
//
// Barrel exposé via `"exports": { ".": "./dist/index.js" }` dans
// package.json. Consommé par `codegraph-mcp`, `dashboard-server`, et
// potentiellement des intégrations externes (Sentinel, hooks bash).
//
// Re-exports the analyzer + synopsis builder + ADR markers helper.
// Internal modules (detectors/, extractors/, graph/, metrics/, etc.) restent
// non-exposés ici — accessibles via paths relatifs si vraiment nécessaire.
//
// ADR-032 (cross-package contracts) : tout ajout/retrait d'export ici a
// un blast radius cross-package. Les tests `tests/cross-package-codegraph.test.ts`
// (codegraph-mcp + dashboard-server + adr-toolkit) verrouillent les exports
// effectivement consommés — modifier doit faire péter ces tests en CI
// AVANT le merge, pas en cascade post-merge.

export * from './core/types.js'
export { analyze } from './core/analyzer.js'
export type { AnalyzeResult } from './core/analyzer.js'
// CodeGraphConfig vit dans core/types.ts (déjà ré-exporté via `export *`)

export {
  buildSynopsis,
  renderLevel1,
  renderLevel2,
  renderLevel3,
  estimateTokens,
} from './synopsis/builder.js'
export type {
  SynopsisJSON,
  SynopsisOptions,
  HubEntry,
  ComponentEntry,
  ContainerEntry,
  CrossEdge,
  EventMapping,
  AdrAnchorSuggestion,
  Phase38Summary,
} from './synopsis/builder.js'

export { collectAdrMarkers } from './synopsis/adr-markers.js'

// ─── Phase D — pipeline composite statique × dynamique × salsa ────────
// Public API pour @liby-tools/runtime-graph (push facts) + consumers
// composite (run rules cross-cut).
export {
  setRuntimeFacts, clearRuntimeFacts,
  runtimeSymbolsTouched, runtimeHttpRouteHits, runtimeDbQueriesExecuted,
  runtimeRedisOps, runtimeEventsEmitted, runtimeCallEdges,
  runtimeLatencySeries, runtimeRunMeta,
  allRuntimeFactsByRelation,
} from './incremental/runtime-relations.js'
export type {
  RuntimeFactsSnapshot, RuntimeSymbolTouchedInput, RuntimeHttpRouteHitInput,
  RuntimeDbQueryExecutedInput, RuntimeRedisOpExecutedInput,
  RuntimeEventEmittedInput, RuntimeCallEdgeInput, RuntimeLatencySeriesInput,
  RuntimeRunMetaInput,
} from './incremental/runtime-relations.js'

export { runCompositeRules } from './datalog-detectors/composite-runner.js'
export type {
  CompositeRunOptions, CompositeRunResult,
} from './datalog-detectors/composite-runner.js'

export {
  loadMemoryRaw, addEntry, markObsolete, deleteEntry, recall,
  memoryPathFor, memoryDir, entryId,
} from './memory/store.js'
export type {
  MemoryEntry, MemoryEntryKind, MemoryEntryScope, MemoryStore,
  RecallScope, AddEntryArgs,
} from './memory/store.js'
