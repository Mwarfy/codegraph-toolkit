// ADR-026 phase D.1 — Salsa input cells pour les facts runtime
/**
 * Pré-requis du pipeline composite statique × dynamique × salsa
 * incremental. Le package `@liby-tools/runtime-graph` push ses facts via
 * `setRuntimeFacts(snapshot)` ; les composite rules (qui joignent
 * statique + dynamique) consomment via `allRuntimeFactsByRelation`.
 *
 * Architecture :
 *   - Input cells per-relation, dans la `sharedDb` codegraph.
 *   - Quand runtime-graph push, les cells bumpent revision.
 *   - Toute cell `derived` qui dep-track sur ces inputs invalide
 *     selectivement → composite rules cachées par Phase C.2 ne re-eval
 *     que si une relation runtime change.
 *
 * Shapes structurels dupliqués depuis `@liby-tools/runtime-graph`
 * (`core/types.ts`) pour éviter la circular dep (runtime-graph dépend
 * de codegraph, pas l'inverse). Si runtime-graph évolue son schema,
 * sync ici manuellement — le test C.2 + composite test attrapera les
 * incompatibilités shape via TS strict.
 */

import { input, derived } from '@liby-tools/salsa'
import { sharedDb as db } from './database.js'

// ─── Shapes structurels (mirror runtime-graph) ─────────────────────────

export interface RuntimeSymbolTouchedInput {
  file: string
  fn: string
  count: number
  p95LatencyMs: number
}

export interface RuntimeHttpRouteHitInput {
  method: string
  path: string
  status: number
  count: number
  p95LatencyMs: number
}

export interface RuntimeDbQueryExecutedInput {
  table: string
  op: string
  count: number
  lastAtUnix: number
}

export interface RuntimeRedisOpExecutedInput {
  op: string
  keyPattern: string
  count: number
}

export interface RuntimeEventEmittedInput {
  type: string
  count: number
  lastAtUnix: number
}

export interface RuntimeCallEdgeInput {
  fromFile: string
  fromFn: string
  toFile: string
  toFn: string
  count: number
}

export interface RuntimeLatencySeriesInput {
  kind: 'http-route' | 'db-table' | 'event-type' | 'symbol'
  key: string
  bucketIdx: number
  count: number
  meanLatencyMs: number
}

export interface RuntimeRunMetaInput {
  driver: string
  startedAtUnix: number
  durationMs: number
  totalSpans: number
  bucketSizeMs?: number
  bucketCount?: number
}

export interface RuntimeFactsSnapshot {
  symbolsTouched: RuntimeSymbolTouchedInput[]
  httpRouteHits: RuntimeHttpRouteHitInput[]
  dbQueriesExecuted: RuntimeDbQueryExecutedInput[]
  redisOps: RuntimeRedisOpExecutedInput[]
  eventsEmitted: RuntimeEventEmittedInput[]
  callEdges: RuntimeCallEdgeInput[]
  latencySeries?: RuntimeLatencySeriesInput[]
  meta: RuntimeRunMetaInput
}

// ─── Input cells (per-relation) ────────────────────────────────────────

export const runtimeSymbolsTouched =
  input<string, readonly RuntimeSymbolTouchedInput[]>(db, 'runtimeSymbolsTouched')
export const runtimeHttpRouteHits =
  input<string, readonly RuntimeHttpRouteHitInput[]>(db, 'runtimeHttpRouteHits')
export const runtimeDbQueriesExecuted =
  input<string, readonly RuntimeDbQueryExecutedInput[]>(db, 'runtimeDbQueriesExecuted')
export const runtimeRedisOps =
  input<string, readonly RuntimeRedisOpExecutedInput[]>(db, 'runtimeRedisOps')
export const runtimeEventsEmitted =
  input<string, readonly RuntimeEventEmittedInput[]>(db, 'runtimeEventsEmitted')
export const runtimeCallEdges =
  input<string, readonly RuntimeCallEdgeInput[]>(db, 'runtimeCallEdges')
export const runtimeLatencySeries =
  input<string, readonly RuntimeLatencySeriesInput[]>(db, 'runtimeLatencySeries')
export const runtimeRunMeta =
  input<string, RuntimeRunMetaInput | null>(db, 'runtimeRunMeta')

// ─── Setter helper ─────────────────────────────────────────────────────

/**
 * Push un snapshot complet runtime dans les cells. À appeler depuis
 * `@liby-tools/runtime-graph` après chaque capture (synthetic/replay/
 * chaos driver). Les cells bumpent revision automatiquement, ce qui
 * invalide les composite rules dans `sharedDb` qui dep-trackent.
 *
 * Convention : tous les sets utilisent la key 'all' (single-snapshot
 * model). Si runtime-graph a un mode multi-runs, étendre la key plus
 * tard (ex: snapshot ID).
 */
export function setRuntimeFacts(snapshot: RuntimeFactsSnapshot): void {
  runtimeSymbolsTouched.set('all', snapshot.symbolsTouched)
  runtimeHttpRouteHits.set('all', snapshot.httpRouteHits)
  runtimeDbQueriesExecuted.set('all', snapshot.dbQueriesExecuted)
  runtimeRedisOps.set('all', snapshot.redisOps)
  runtimeEventsEmitted.set('all', snapshot.eventsEmitted)
  runtimeCallEdges.set('all', snapshot.callEdges)
  runtimeLatencySeries.set('all', snapshot.latencySeries ?? [])
  runtimeRunMeta.set('all', snapshot.meta)
}

/**
 * Reset complet — les cells deviennent vides. Utile en tests pour
 * isolation, et au boot d'un watcher mode avant la première capture.
 */
export function clearRuntimeFacts(): void {
  runtimeSymbolsTouched.set('all', [])
  runtimeHttpRouteHits.set('all', [])
  runtimeDbQueriesExecuted.set('all', [])
  runtimeRedisOps.set('all', [])
  runtimeEventsEmitted.set('all', [])
  runtimeCallEdges.set('all', [])
  runtimeLatencySeries.set('all', [])
  runtimeRunMeta.set('all', null)
}

// ─── Aggregator : Map<RelationName, TSV> pour Datalog runner ──────────

/**
 * Sanitize TSV — strip control chars qui briseraient l'arity (cf.
 * `runner.ts`). Les strings runtime peuvent contenir des chars
 * particuliers (paths, query templates, etc.).
 */
const SAFE_CTRL_RE = /[\x00-\x1F\x7F]/g  // eslint-disable-line no-control-regex
const safe = (s: string): string => s.replace(SAFE_CTRL_RE, ' ')
const num = (n: number): string => String(Math.trunc(n))

/**
 * Produit la `factsByRelation` Map<RelationName, TSV> pour les facts
 * runtime — format identique à celui consommé par `evaluateCached`
 * dans `runner.ts`. Le composite runner (D.2) merge cette map avec
 * la Map statique pour évaluer les rules cross-cut.
 *
 * Cell `derived` Salsa : invalide automatiquement quand n'importe quel
 * input runtime cell change. Warm path = cache hit cross-cut.
 */
export const allRuntimeFactsByRelation = derived<string, Map<string, string>>(
  db, 'allRuntimeFactsByRelation',
  (_label) => {
    const m = new Map<string, string>()
    m.set('SymbolTouchedRuntime',
      runtimeSymbolsTouched.get('all').map((f) =>
        [safe(f.file), safe(f.fn), num(f.count), num(f.p95LatencyMs)].join('\t'),
      ).join('\n'))
    m.set('HttpRouteHit',
      runtimeHttpRouteHits.get('all').map((f) =>
        [safe(f.method), safe(f.path), num(f.status), num(f.count), num(f.p95LatencyMs)].join('\t'),
      ).join('\n'))
    m.set('DbQueryExecuted',
      runtimeDbQueriesExecuted.get('all').map((f) =>
        [safe(f.table), safe(f.op), num(f.count), num(f.lastAtUnix)].join('\t'),
      ).join('\n'))
    m.set('RedisOpExecuted',
      runtimeRedisOps.get('all').map((f) =>
        [safe(f.op), safe(f.keyPattern), num(f.count)].join('\t'),
      ).join('\n'))
    m.set('EventEmittedAtRuntime',
      runtimeEventsEmitted.get('all').map((f) =>
        [safe(f.type), num(f.count), num(f.lastAtUnix)].join('\t'),
      ).join('\n'))
    m.set('CallEdgeRuntime',
      runtimeCallEdges.get('all').map((f) =>
        [safe(f.fromFile), safe(f.fromFn), safe(f.toFile), safe(f.toFn), num(f.count)].join('\t'),
      ).join('\n'))
    m.set('LatencySeries',
      runtimeLatencySeries.get('all').map((f) =>
        [f.kind, safe(f.key), num(f.bucketIdx), num(f.count), num(f.meanLatencyMs)].join('\t'),
      ).join('\n'))
    const meta = runtimeRunMeta.get('all')
    m.set('RuntimeRunMeta', meta
      ? [safe(meta.driver), num(meta.startedAtUnix), num(meta.durationMs),
         num(meta.totalSpans), num(meta.bucketSizeMs ?? 0), num(meta.bucketCount ?? 0)].join('\t')
      : '')
    return m
  },
)
