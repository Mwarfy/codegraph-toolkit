/**
 * Span aggregator tests — vérifie la projection ReadableSpan → facts.
 *
 * On synthétise des spans minimaux (pas de SDK OTel actif) avec les
 * attributes qu'on consomme, puis on appelle aggregateSpans et on vérifie
 * la sortie.
 */

import { describe, it, expect } from 'vitest'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { aggregateSpans } from '../src/capture/span-aggregator.js'

function fakeSpan(opts: {
  spanId?: string
  parentSpanId?: string
  attributes: Record<string, unknown>
  durationMs?: number
  endTimeUnix?: number
}): ReadableSpan {
  const durationMs = opts.durationMs ?? 5
  const endTime = opts.endTimeUnix ?? 1_700_000_000
  // Cast for the minimal subset we use — we don't implement the full ReadableSpan interface.
  return {
    spanContext: () => ({
      spanId: opts.spanId ?? Math.random().toString(36).slice(2, 18),
      traceId: 'trace-1',
      traceFlags: 1,
      traceState: undefined,
    }),
    parentSpanContext: opts.parentSpanId
      ? { spanId: opts.parentSpanId, traceId: 'trace-1', traceFlags: 1, traceState: undefined }
      : undefined,
    attributes: opts.attributes,
    duration: [Math.floor(durationMs / 1000), (durationMs % 1000) * 1_000_000],
    endTime: [endTime, 0],
  } as unknown as ReadableSpan
}

const meta = {
  driver: 'test',
  startedAtUnix: 1_700_000_000,
  durationMs: 1000,
  totalSpans: 0,
}

describe('aggregateSpans', () => {
  it('extracts SymbolTouchedRuntime from code.filepath + code.function', () => {
    const spans = [
      fakeSpan({
        attributes: {
          'code.filepath': '/proj/src/foo.ts',
          'code.function': 'doFoo',
        },
        durationMs: 10,
      }),
      fakeSpan({
        attributes: {
          'code.filepath': '/proj/src/foo.ts',
          'code.function': 'doFoo',
        },
        durationMs: 20,
      }),
      fakeSpan({
        attributes: {
          'code.filepath': '/proj/src/bar.ts',
          'code.function': 'doBar',
        },
        durationMs: 5,
      }),
    ]
    const snap = aggregateSpans(spans, { projectRoot: '/proj', runMeta: meta })
    expect(snap.symbolsTouched).toHaveLength(2)
    const foo = snap.symbolsTouched.find(s => s.fn === 'doFoo')
    expect(foo).toBeDefined()
    expect(foo!.file).toBe('src/foo.ts')                                // relative to projectRoot
    expect(foo!.count).toBe(2)
  })

  it('filters out node_modules from SymbolTouchedRuntime', () => {
    const spans = [
      fakeSpan({
        attributes: {
          'code.filepath': '/proj/node_modules/lodash/index.js',
          'code.function': 'cloneDeep',
        },
      }),
    ]
    const snap = aggregateSpans(spans, { projectRoot: '/proj', runMeta: meta })
    expect(snap.symbolsTouched).toHaveLength(0)
  })

  it('honors liby.* attributes preferentially over code.*', () => {
    const spans = [
      fakeSpan({
        attributes: {
          'code.filepath': '/proj/src/auto.ts',                          // would be picked
          'code.function': 'auto',
          'liby.file': '/proj/src/manual.ts',                            // wins
          'liby.fn': 'manual',
        },
      }),
    ]
    const snap = aggregateSpans(spans, { projectRoot: '/proj', runMeta: meta })
    expect(snap.symbolsTouched).toHaveLength(1)
    expect(snap.symbolsTouched[0].file).toBe('src/manual.ts')
    expect(snap.symbolsTouched[0].fn).toBe('manual')
  })

  it('aggregates HttpRouteHit by (method, path, status)', () => {
    const spans = [
      fakeSpan({
        attributes: { 'http.method': 'GET', 'http.route': '/api/foo', 'http.status_code': 200 },
        durationMs: 50,
      }),
      fakeSpan({
        attributes: { 'http.method': 'GET', 'http.route': '/api/foo', 'http.status_code': 200 },
        durationMs: 60,
      }),
      fakeSpan({
        attributes: { 'http.method': 'GET', 'http.route': '/api/foo', 'http.status_code': 404 },
        durationMs: 10,
      }),
    ]
    const snap = aggregateSpans(spans, { projectRoot: '/proj', runMeta: meta })
    expect(snap.httpRouteHits).toHaveLength(2)
    const ok = snap.httpRouteHits.find(h => h.status === 200)!
    expect(ok.count).toBe(2)
  })

  it('strips query string from http path', () => {
    const spans = [
      fakeSpan({
        attributes: { 'http.method': 'GET', 'http.target': '/api/foo?q=1', 'http.status_code': 200 },
      }),
    ]
    const snap = aggregateSpans(spans, { projectRoot: '/proj', runMeta: meta })
    expect(snap.httpRouteHits[0].path).toBe('/api/foo')
  })

  it('extracts DbQueryExecuted with table + op from db.statement', () => {
    const spans = [
      fakeSpan({
        attributes: { 'db.system': 'postgresql', 'db.statement': 'SELECT * FROM orders WHERE id = $1' },
        endTimeUnix: 1_700_000_100,
      }),
      fakeSpan({
        attributes: { 'db.system': 'postgresql', 'db.statement': 'INSERT INTO orders (x) VALUES ($1)' },
        endTimeUnix: 1_700_000_200,
      }),
      fakeSpan({
        attributes: { 'db.system': 'postgresql', 'db.statement': 'UPDATE users SET name = $1' },
      }),
    ]
    const snap = aggregateSpans(spans, { projectRoot: '/proj', runMeta: meta })
    expect(snap.dbQueriesExecuted).toHaveLength(3)
    const ordersSelect = snap.dbQueriesExecuted.find(d => d.table === 'orders' && d.op === 'SELECT')
    expect(ordersSelect).toBeDefined()
    const ordersInsert = snap.dbQueriesExecuted.find(d => d.table === 'orders' && d.op === 'INSERT')
    expect(ordersInsert!.lastAtUnix).toBe(1_700_000_200)
  })

  it('extracts MongoDB queries via db.mongodb.collection + db.operation', () => {
    const spans = [
      fakeSpan({
        attributes: {
          'db.system': 'mongodb',
          'db.mongodb.collection': 'users',
          'db.operation': 'find',
        },
        endTimeUnix: 1_700_000_300,
      }),
      fakeSpan({
        attributes: {
          'db.system': 'mongodb',
          'db.mongodb.collection': 'users',
          'db.operation': 'insert',
        },
      }),
      fakeSpan({
        attributes: {
          'db.system': 'mongodb',
          'db.mongodb.collection': 'orders',
          'db.operation': 'aggregate',
        },
      }),
    ]
    const snap = aggregateSpans(spans, { projectRoot: '/proj', runMeta: meta })
    expect(snap.dbQueriesExecuted).toHaveLength(3)
    const usersFind = snap.dbQueriesExecuted.find(d => d.table === 'users' && d.op === 'FIND')
    expect(usersFind).toBeDefined()
    const ordersAgg = snap.dbQueriesExecuted.find(d => d.table === 'orders' && d.op === 'AGGREGATE')
    expect(ordersAgg).toBeDefined()
  })

  it('routes redis to RedisOpExecuted not DbQueryExecuted', () => {
    const spans = [
      fakeSpan({
        attributes: { 'db.system': 'redis', 'db.statement': 'GET user:42' },
      }),
      fakeSpan({
        attributes: { 'db.system': 'redis', 'db.statement': 'SET user:43 some-value' },
      }),
    ]
    const snap = aggregateSpans(spans, { projectRoot: '/proj', runMeta: meta })
    expect(snap.dbQueriesExecuted).toHaveLength(0)
    expect(snap.redisOps).toHaveLength(2)
    const get = snap.redisOps.find(r => r.op === 'GET')!
    expect(get.keyPattern).toBe('user:*')                                // numeric collapsed
  })

  it('extracts EventEmittedAtRuntime from liby.event.type', () => {
    const spans = [
      fakeSpan({
        attributes: { 'liby.event.type': 'video.publish.requested' },
        endTimeUnix: 1_700_000_500,
      }),
      fakeSpan({
        attributes: { 'liby.event.type': 'video.publish.requested' },
        endTimeUnix: 1_700_000_600,
      }),
      fakeSpan({
        attributes: { 'liby.event.type': 'render.completed' },
      }),
    ]
    const snap = aggregateSpans(spans, { projectRoot: '/proj', runMeta: meta })
    expect(snap.eventsEmitted).toHaveLength(2)
    const publishReq = snap.eventsEmitted.find(e => e.type === 'video.publish.requested')!
    expect(publishReq.count).toBe(2)
    expect(publishReq.lastAtUnix).toBe(1_700_000_600)                    // most recent
  })

  it('builds CallEdgeRuntime from parent-child span relationships', () => {
    const spans = [
      fakeSpan({
        spanId: 'p1',
        attributes: { 'code.filepath': '/proj/src/a.ts', 'code.function': 'callerFn' },
      }),
      fakeSpan({
        spanId: 'c1',
        parentSpanId: 'p1',
        attributes: { 'code.filepath': '/proj/src/b.ts', 'code.function': 'calleeFn' },
      }),
    ]
    const snap = aggregateSpans(spans, { projectRoot: '/proj', runMeta: meta })
    expect(snap.callEdges).toHaveLength(1)
    expect(snap.callEdges[0].fromFile).toBe('src/a.ts')
    expect(snap.callEdges[0].fromFn).toBe('callerFn')
    expect(snap.callEdges[0].toFile).toBe('src/b.ts')
    expect(snap.callEdges[0].toFn).toBe('calleeFn')
    expect(snap.callEdges[0].count).toBe(1)
  })

  it('preserves run meta as-is', () => {
    const snap = aggregateSpans([], { projectRoot: '/proj', runMeta: meta })
    expect(snap.meta).toEqual(meta)
  })
})
