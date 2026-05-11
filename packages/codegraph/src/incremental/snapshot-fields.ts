// ADR-033
/**
 * Listes runtime des champs `DetectorOutputs` et `SnapshotMetrics`.
 *
 * Le découpage est défini au type-level dans `core/types.ts` (cf. ADR-033
 * sub-domains). Ces const arrays exposent les noms à runtime — TypeScript
 * vérifie via `satisfies readonly (keyof XXX)[]` que tous les noms sont
 * valides ET un type-level exhaustiveness check garantit qu'aucun champ
 * n'est oublié.
 *
 * Conséquence : ajouter un nouveau champ à `DetectorOutputs` ou
 * `SnapshotMetrics` sans l'ajouter ici fait péter la compilation TS
 * (les `const _exhaustive: true = true` deviennent `: never = true`).
 *
 * Phase 1 ADR-033 utilise ces listes dans `writeSubSnapshots` pour
 * matérialiser un fichier par detector + un fichier metrics agrégé.
 * Phase 2 les utilisera dans les loaders typés (`loadDetectorOutput`,
 * `loadMetrics`).
 */

import type { DetectorOutputs, SnapshotMetrics } from '../core/types.js'

/**
 * Liste des champs de `DetectorOutputs`. Ordre stable (ne pas réordonner
 * arbitrairement — l'ordre conditionne le layout des fichiers
 * `snapshot.detectors/<field>.ndjson` sur disque, mais pas leur contenu).
 */
export const DETECTOR_FIELDS = [
  'cycles',
  'truthPoints',
  'dataFlows',
  'stateMachines',
  'envUsage',
  'taintViolations',
  'packageDeps',
  'binShebangIssues',
  'barrels',
  'eventEmitSites',
  'oauthScopeLiterals',
  'todos',
  'driftSignals',
  'longFunctions',
  'magicNumbers',
  'testCoverage',
  'coChangePairs',
  'sqlSchema',
  'evalCalls',
  'cryptoCalls',
  'eventListenerSites',
  'codeQualityPatterns',
  'securityPatterns',
  'hardcodedSecrets',
  'booleanParams',
  'deadCode',
  'floatingPromises',
  'deprecatedUsage',
  'articulationPoints',
  'articulationGrandfathered',
  'constantExpressions',
  'eslintViolations',
  'sqlNamingViolations',
  'sqlMigrationOrderViolations',
  'resourceImbalances',
  'taintSinks',
  'sanitizerCalls',
  'argumentsFacts',
  'taintedVars',
  'docClaims',
  'docStaleClaims',
] as const satisfies readonly (keyof DetectorOutputs)[]

export type DetectorFieldName = (typeof DETECTOR_FIELDS)[number]

/**
 * Liste des champs de `SnapshotMetrics`. Métriques cross-discipline
 * agrégées (PageRank, Lyapunov, Fiedler, Newman-Girvan modularity,
 * Tishby IB, etc.).
 */
export const METRIC_FIELDS = [
  'moduleMetrics',
  'componentMetrics',
  'dsm',
  'functionComplexity',
  'spectralMetrics',
  'symbolEntropy',
  'signatureDuplicates',
  'persistentCycles',
  'lyapunovMetrics',
  'packageMinCuts',
  'informationBottlenecks',
  'importCommunities',
  'modularityScore',
  'factStabilities',
  'bayesianCoChanges',
  'compressionDistances',
  'grangerCausalities',
] as const satisfies readonly (keyof SnapshotMetrics)[]

export type MetricFieldName = (typeof METRIC_FIELDS)[number]

// ─── Type-level exhaustiveness checks ──────────────────────────────────────
//
// Si un champ existe dans `DetectorOutputs` mais n'est PAS dans
// `DETECTOR_FIELDS`, alors `Exclude<keyof DetectorOutputs, DetectorFieldName>`
// n'est pas `never` → le type devient `never` → l'assignation échoue à la
// compile. Idem pour `MetricFieldName`. Garantie type-safe que les listes
// runtime restent exhaustives.

type _DetectorFieldsExhaustive =
  Exclude<keyof DetectorOutputs, DetectorFieldName> extends never ? true : never
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _detectorFieldsExhaustive: _DetectorFieldsExhaustive = true

type _MetricFieldsExhaustive =
  Exclude<keyof SnapshotMetrics, MetricFieldName> extends never ? true : never
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _metricFieldsExhaustive: _MetricFieldsExhaustive = true
