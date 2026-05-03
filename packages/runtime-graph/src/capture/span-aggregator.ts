// ADR-011
/**
 * Span aggregator — projette les ReadableSpan OTel vers les facts canoniques.
 *
 * Phase α : 6 facts (sauf RuntimeRunMeta qui est ajouté côté CLI).
 * Le découpage par fact est fait via les span attributes OTel standards :
 *   - http.method + http.target → HttpRouteHit
 *   - db.system + db.statement → DbQueryExecuted
 *   - net.peer.name = 'redis' / db.system = 'redis' → RedisOpExecuted
 *   - code.filepath + code.function → SymbolTouchedRuntime
 *   - sentinel.event.type (custom attribute) → EventEmittedAtRuntime
 *
 * Les spans sans attribute matchant sont ignorés (n'enrichissent aucun fact).
 * C'est OK : OTel auto-instrument capture + d'infos qu'on n'a pas besoin.
 */

import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'
import type {
  RuntimeSnapshot,
  SymbolTouchedRuntimeFact,
  HttpRouteHitFact,
  DbQueryExecutedFact,
  RedisOpExecutedFact,
  EventEmittedAtRuntimeFact,
  CallEdgeRuntimeFact,
  LatencySeriesFact,
} from '../core/types.js'

/** OTel SemConv attribute keys we care about (subset). */
const ATTR = {
  HTTP_METHOD: 'http.method',
  HTTP_ROUTE: 'http.route',                                            // template (preferred)
  HTTP_TARGET: 'http.target',                                          // raw URL fallback
  HTTP_STATUS: 'http.status_code',
  DB_SYSTEM: 'db.system',
  DB_STATEMENT: 'db.statement',
  DB_OPERATION: 'db.operation',
  DB_MONGODB_COLLECTION: 'db.mongodb.collection',                       // OTel SemConv MongoDB
  DB_NAME: 'db.name',                                                  // database name (fallback)
  CODE_FILEPATH: 'code.filepath',
  CODE_FUNCTION: 'code.function',
  CODE_NAMESPACE: 'code.namespace',
  // Custom attributes — projects can set these via OTel API
  RG_EVENT_TYPE: 'liby.event.type',                                    // émis par hook custom event-bus
  RG_FILE: 'liby.file',                                                // alternative à code.filepath
  RG_FN: 'liby.fn',                                                    // alternative à code.function
} as const

/**
 * Project les spans vers un RuntimeSnapshot.
 * IDEMPOTENT — appelable plusieurs fois sur le même array de spans.
 *
 * Si `runMeta.bucketSizeMs` est défini (γ.2+), génère aussi `latencySeries`
 * via bucketisation par fenêtre temporelle.
 */
export function aggregateSpans(
  spans: ReadableSpan[],
  opts: { projectRoot: string; runMeta: RuntimeSnapshot['meta'] },
): RuntimeSnapshot {
  const symbolsTouched = aggregateSymbolsTouched(spans, opts.projectRoot)
  const httpRouteHits = aggregateHttpRouteHits(spans)
  const dbQueriesExecuted = aggregateDbQueries(spans)
  const redisOps = aggregateRedisOps(spans)
  const eventsEmitted = aggregateEventsEmitted(spans)
  const callEdges = aggregateCallEdges(spans, opts.projectRoot)

  const bucketSizeMs = opts.runMeta.bucketSizeMs
  const latencySeries = bucketSizeMs && bucketSizeMs > 0
    ? aggregateLatencySeries(spans, opts.projectRoot, opts.runMeta.startedAtUnix, bucketSizeMs)
    : undefined

  return {
    symbolsTouched,
    httpRouteHits,
    dbQueriesExecuted,
    redisOps,
    eventsEmitted,
    callEdges,
    latencySeries,
    meta: opts.runMeta,
  }
}

// ─── SymbolTouchedRuntime ─────────────────────────────────────────────────

interface SymKey { file: string; fn: string }

function aggregateSymbolsTouched(
  spans: ReadableSpan[],
  projectRoot: string,
): SymbolTouchedRuntimeFact[] {
  // Group by (file, fn) → count + p95 latency
  const buckets = new Map<string, { file: string; fn: string; durations: number[] }>()

  for (const span of spans) {
    const key = extractSymbolKey(span, projectRoot)
    if (!key) continue
    const id = `${key.file}::${key.fn}`
    let bucket = buckets.get(id)
    if (!bucket) {
      bucket = { file: key.file, fn: key.fn, durations: [] }
      buckets.set(id, bucket)
    }
    bucket.durations.push(spanDurationMs(span))
  }

  return Array.from(buckets.values()).map(b => ({
    file: b.file,
    fn: b.fn,
    count: b.durations.length,
    p95LatencyMs: percentile(b.durations, 0.95),
  }))
}

function extractSymbolKey(span: ReadableSpan, projectRoot: string): SymKey | null {
  const attrs = span.attributes
  // Préférer les custom liby.* attributes (déjà filtrés au project), fallback OTel SemConv
  let file = (attrs[ATTR.RG_FILE] as string | undefined) ?? (attrs[ATTR.CODE_FILEPATH] as string | undefined)
  const fn = (attrs[ATTR.RG_FN] as string | undefined) ?? (attrs[ATTR.CODE_FUNCTION] as string | undefined)
  if (!file || !fn) return null
  // Normaliser : path absolu → relatif depuis projectRoot
  if (file.startsWith(projectRoot)) {
    file = file.slice(projectRoot.length).replace(/^\/+/, '')
  }
  // Filtre : exclure node_modules + paths hors projet
  if (file.includes('node_modules') || file.startsWith('/')) return null
  return { file, fn }
}

// ─── HttpRouteHit ─────────────────────────────────────────────────────────

function aggregateHttpRouteHits(spans: ReadableSpan[]): HttpRouteHitFact[] {
  const buckets = new Map<string, {
    method: string; path: string; status: number; durations: number[]
  }>()

  for (const span of spans) {
    const attrs = span.attributes
    const method = attrs[ATTR.HTTP_METHOD] as string | undefined
    const path = (attrs[ATTR.HTTP_ROUTE] as string | undefined)
              ?? (attrs[ATTR.HTTP_TARGET] as string | undefined)
    const status = attrs[ATTR.HTTP_STATUS] as number | undefined
    if (!method || !path || status === undefined) continue
    const id = `${method}::${path}::${status}`
    let bucket = buckets.get(id)
    if (!bucket) {
      bucket = { method, path: stripQueryString(path), status, durations: [] }
      buckets.set(id, bucket)
    }
    bucket.durations.push(spanDurationMs(span))
  }

  return Array.from(buckets.values()).map(b => ({
    method: b.method,
    path: b.path,
    status: b.status,
    count: b.durations.length,
    p95LatencyMs: percentile(b.durations, 0.95),
  }))
}

function stripQueryString(path: string): string {
  const i = path.indexOf('?')
  return i === -1 ? path : path.slice(0, i)
}

// ─── DbQueryExecuted ──────────────────────────────────────────────────────

function aggregateDbQueries(spans: ReadableSpan[]): DbQueryExecutedFact[] {
  const buckets = new Map<string, {
    table: string; op: string; count: number; lastAtUnix: number
  }>()

  for (const span of spans) {
    const attrs = span.attributes
    const dbSystem = attrs[ATTR.DB_SYSTEM] as string | undefined
    if (!dbSystem || dbSystem === 'redis') continue                    // redis va dans son propre fact

    let table: string | null = null
    let op: string | null = null

    if (dbSystem === 'mongodb') {
      // MongoDB : `db.mongodb.collection` est explicite, op vient de
      // db.operation (find/insert/update/delete/aggregate).
      table = (attrs[ATTR.DB_MONGODB_COLLECTION] as string | undefined) ?? null
      op = ((attrs[ATTR.DB_OPERATION] as string | undefined) ?? '').toUpperCase() || null
    } else {
      // Postgres / MySQL / SQLite / etc. — parse depuis db.statement.
      const stmt = attrs[ATTR.DB_STATEMENT] as string | undefined
      op = (attrs[ATTR.DB_OPERATION] as string | undefined) ?? extractSqlOp(stmt)
      table = extractSqlTable(stmt)
    }

    if (!table || !op) continue
    const id = `${table}::${op}`
    const endTime = spanEndUnix(span)
    let bucket = buckets.get(id)
    if (!bucket) {
      bucket = { table, op, count: 0, lastAtUnix: endTime }
      buckets.set(id, bucket)
    }
    bucket.count++
    if (endTime > bucket.lastAtUnix) bucket.lastAtUnix = endTime
  }

  return Array.from(buckets.values())
}

function extractSqlOp(stmt: string | undefined): string | null {
  if (!stmt) return null
  const m = stmt.trim().match(/^(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE)/i)
  return m ? m[1].toUpperCase() : null
}

function extractSqlTable(stmt: string | undefined): string | null {
  if (!stmt) return null
  // Best-effort regex — pas un parseur SQL complet en α.
  // Patterns couverts :
  //   FROM <table>           — SELECT
  //   INTO <table>           — INSERT
  //   UPDATE <table>         — UPDATE
  //   FROM <table>           — DELETE
  const m = stmt.match(/(?:FROM|INTO|UPDATE)\s+([a-zA-Z_][a-zA-Z0-9_]*)/i)
  return m ? m[1] : null
}

// ─── RedisOpExecuted ─────────────────────────────────────────────────────

function aggregateRedisOps(spans: ReadableSpan[]): RedisOpExecutedFact[] {
  const buckets = new Map<string, { op: string; keyPattern: string; count: number }>()

  for (const span of spans) {
    const attrs = span.attributes
    const dbSystem = attrs[ATTR.DB_SYSTEM] as string | undefined
    if (dbSystem !== 'redis') continue
    const stmt = attrs[ATTR.DB_STATEMENT] as string | undefined
    if (!stmt) continue
    const parts = stmt.trim().split(/\s+/)
    if (parts.length === 0) continue
    const op = parts[0].toUpperCase()
    const key = parts[1] ?? '*'
    const keyPattern = collapseKeyPattern(key)
    const id = `${op}::${keyPattern}`
    let bucket = buckets.get(id)
    if (!bucket) {
      bucket = { op, keyPattern, count: 0 }
      buckets.set(id, bucket)
    }
    bucket.count++
  }

  return Array.from(buckets.values())
}

function collapseKeyPattern(key: string): string {
  // Heuristique : remplace les segments numériques / UUID par '*'
  return key
    .replace(/:[0-9]+(?=:|$)/g, ':*')
    .replace(/:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=:|$)/gi, ':*')
}

// ─── EventEmittedAtRuntime ───────────────────────────────────────────────

function aggregateEventsEmitted(spans: ReadableSpan[]): EventEmittedAtRuntimeFact[] {
  const buckets = new Map<string, { type: string; count: number; lastAtUnix: number }>()

  for (const span of spans) {
    const attrs = span.attributes
    const type = attrs[ATTR.RG_EVENT_TYPE] as string | undefined
    if (!type) continue
    const endTime = spanEndUnix(span)
    let bucket = buckets.get(type)
    if (!bucket) {
      bucket = { type, count: 0, lastAtUnix: endTime }
      buckets.set(type, bucket)
    }
    bucket.count++
    if (endTime > bucket.lastAtUnix) bucket.lastAtUnix = endTime
  }

  return Array.from(buckets.values())
}

// ─── CallEdgeRuntime ─────────────────────────────────────────────────────

function aggregateCallEdges(
  spans: ReadableSpan[],
  projectRoot: string,
): CallEdgeRuntimeFact[] {
  // Build span-id → {file, fn} index
  const symbols = new Map<string, SymKey>()
  for (const span of spans) {
    const sym = extractSymbolKey(span, projectRoot)
    if (sym) {
      symbols.set(span.spanContext().spanId, sym)
    }
  }

  // Pour chaque span avec parent, construire l'edge si parent ET child ont une symbol key
  const buckets = new Map<string, {
    fromFile: string; fromFn: string; toFile: string; toFn: string; count: number
  }>()

  for (const span of spans) {
    const childSym = symbols.get(span.spanContext().spanId)
    if (!childSym) continue
    // OTel ReadableSpan exposes parentSpanContext on newer versions, parentSpanId on older.
    // Cast to access either.
    const spanAny = span as unknown as {
      parentSpanContext?: { spanId?: string }
      parentSpanId?: string
    }
    const parentId = spanAny.parentSpanContext?.spanId ?? spanAny.parentSpanId
    if (!parentId) continue
    const parentSym = symbols.get(parentId)
    if (!parentSym) continue
    const id = `${parentSym.file}::${parentSym.fn}->${childSym.file}::${childSym.fn}`
    let bucket = buckets.get(id)
    if (!bucket) {
      bucket = {
        fromFile: parentSym.file, fromFn: parentSym.fn,
        toFile: childSym.file, toFn: childSym.fn,
        count: 0,
      }
      buckets.set(id, bucket)
    }
    bucket.count++
  }

  return Array.from(buckets.values())
}

// ─── LatencySeries (γ.2 — time-series buckets) ──────────────────────────

/**
 * Bucketise les spans en fenêtres de `bucketSizeMs` à partir de
 * `startedAtUnix`. Génère 1 row par (kind, key, bucketIdx) où `count > 0`
 * (sparse). Permet l'analyse causale lag-N (Granger), time-series Lyapunov,
 * et TDA persistence (γ.3) sur des séries temporelles courtes (run window).
 *
 * 4 kinds en γ.2 :
 *   - http-route : key = "<METHOD> <path>"
 *   - db-table   : key = "<table>::<op>"
 *   - event-type : key = "<type>"
 *   - symbol     : key = "<file>::<fn>"
 */
function aggregateLatencySeries(
  spans: ReadableSpan[],
  projectRoot: string,
  startedAtUnix: number,
  bucketSizeMs: number,
): LatencySeriesFact[] {
  // Bucket key = `${kind}\x00${key}\x00${bucketIdx}` → { latencies: number[] }
  const buckets = new Map<string, {
    kind: LatencySeriesFact['kind']
    key: string
    bucketIdx: number
    latencies: number[]
  }>()

  const startedAtMs = startedAtUnix * 1000

  for (const span of spans) {
    const [sec, nsec] = span.startTime
    const startMs = sec * 1000 + nsec / 1_000_000
    const offsetMs = startMs - startedAtMs
    if (offsetMs < 0) continue                                            // span started before run window
    const bucketIdx = Math.floor(offsetMs / bucketSizeMs)
    const latencyMs = spanDurationMs(span)

    const kindKeys = extractKindKeys(span, projectRoot)
    for (const { kind, key } of kindKeys) {
      const id = `${kind}\x00${key}\x00${bucketIdx}`
      let b = buckets.get(id)
      if (!b) {
        b = { kind, key, bucketIdx, latencies: [] }
        buckets.set(id, b)
      }
      b.latencies.push(latencyMs)
    }
  }

  return Array.from(buckets.values()).map(b => ({
    kind: b.kind,
    key: b.key,
    bucketIdx: b.bucketIdx,
    count: b.latencies.length,
    meanLatencyMs: b.latencies.length === 0
      ? 0
      : Math.floor(b.latencies.reduce((s, x) => s + x, 0) / b.latencies.length),
  }))
}

/**
 * Extrait les (kind, key) pour un span — un même span peut contribuer à
 * plusieurs séries (ex: span HTTP route + symbol touched). Permet la
 * réutilisation des spans existants au lieu de les re-walker.
 */
function extractKindKeys(
  span: ReadableSpan,
  projectRoot: string,
): Array<{ kind: LatencySeriesFact['kind']; key: string }> {
  const out: Array<{ kind: LatencySeriesFact['kind']; key: string }> = []
  const attrs = span.attributes

  // http-route
  const method = attrs[ATTR.HTTP_METHOD] as string | undefined
  const httpPath = (attrs[ATTR.HTTP_ROUTE] as string | undefined)
                ?? (attrs[ATTR.HTTP_TARGET] as string | undefined)
  if (method && httpPath) {
    out.push({ kind: 'http-route', key: `${method} ${stripQueryString(httpPath)}` })
  }

  // db-table
  const dbSystem = attrs[ATTR.DB_SYSTEM] as string | undefined
  if (dbSystem && dbSystem !== 'redis') {
    let table: string | null = null
    let op: string | null = null
    if (dbSystem === 'mongodb') {
      table = (attrs[ATTR.DB_MONGODB_COLLECTION] as string | undefined) ?? null
      op = ((attrs[ATTR.DB_OPERATION] as string | undefined) ?? '').toUpperCase() || null
    } else {
      const stmt = attrs[ATTR.DB_STATEMENT] as string | undefined
      op = (attrs[ATTR.DB_OPERATION] as string | undefined) ?? extractSqlOp(stmt)
      table = extractSqlTable(stmt)
    }
    if (table && op) out.push({ kind: 'db-table', key: `${table}::${op}` })
  }

  // event-type (custom OTel attribute set by event-bus hook)
  const eventType = attrs[ATTR.RG_EVENT_TYPE] as string | undefined
  if (eventType) out.push({ kind: 'event-type', key: eventType })

  // symbol (project code only)
  const symKey = extractSymbolKey(span, projectRoot)
  if (symKey) out.push({ kind: 'symbol', key: `${symKey.file}::${symKey.fn}` })

  return out
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function spanDurationMs(span: ReadableSpan): number {
  const [sec, nsec] = span.duration                                     // [seconds, nanoseconds]
  return Math.floor(sec * 1000 + nsec / 1_000_000)
}

function spanEndUnix(span: ReadableSpan): number {
  const [sec] = span.endTime                                            // [seconds, nanoseconds]
  return sec
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p))
  return sorted[idx]
}
