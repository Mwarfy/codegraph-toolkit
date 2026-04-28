// @liby/adr-toolkit — public API surface
//
// Toutes les opérations de gouvernance ADR (regen anchors, linker file→ADRs,
// ts-morph asserts, brief generator, init projet) exposées comme fonctions
// pures + types. Le CLI (`adr-toolkit` binaire) est juste un wrapper autour
// de ces helpers.

export { loadConfig, CONFIG_FILENAME } from './config.js'
export type { AdrToolkitConfig } from './config.js'

export { regenerateAnchors } from './regenerate-anchors.js'
export type { RegenOptions, RegenResult } from './regenerate-anchors.js'

export { loadADRs, matches, findAdrsForFile } from './linker.js'
export type { ADRRef } from './linker.js'

export { checkAsserts } from './check-asserts.js'
export type {
  CheckAssertsOptions,
  CheckAssertsResult,
  CheckResult,
} from './check-asserts.js'

export { generateBrief } from './brief.js'
export type {
  GenerateBriefOptions,
  GenerateBriefResult,
} from './brief.js'

export { initProject } from './init.js'

export {
  bootstrapAdrs,
  detectSingletonCandidates,
} from './bootstrap.js'
export type {
  BootstrapOptions,
  BootstrapResult,
  AdrDraft,
  PatternCandidate,
  PatternKind,
} from './bootstrap.js'

export { applyDrafts } from './bootstrap-writer.js'
export type { ApplyOptions, ApplyResult } from './bootstrap-writer.js'
