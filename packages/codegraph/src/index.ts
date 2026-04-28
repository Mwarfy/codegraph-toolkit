// @liby/codegraph — public API surface
//
// Re-exports the analyzer + synopsis builder + ADR markers helper.
// Internal modules (detectors/, extractors/, graph/, metrics/, etc.) restent
// non-exposés ici — accessibles via paths relatifs si vraiment nécessaire.

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
