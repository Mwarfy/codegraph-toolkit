/**
 * Phase γ.2 Granger runtime — unit tests.
 * Pure math on synthetic time-series — no I/O, deterministic.
 */

import { describe, it, expect } from 'vitest'
import {
  grangerRuntime,
  grangerRuntimeFileRollup,
  type GrangerRuntimeFact,
} from '../src/metrics/granger-runtime.js'
import type { LatencySeriesFact, RuntimeSnapshot } from '../src/core/types.js'

const baseMeta = {
  driver: 'test',
  startedAtUnix: 1700000000,
  durationMs: 60000,
  totalSpans: 0,
  bucketSizeMs: 1000,
  bucketCount: 60,
}

function snap(latencySeries: LatencySeriesFact[], bucketCount = 60): RuntimeSnapshot {
  return {
    symbolsTouched: [],
    httpRouteHits: [],
    dbQueriesExecuted: [],
    redisOps: [],
    eventsEmitted: [],
    callEdges: [],
    latencySeries,
    meta: { ...baseMeta, bucketCount },
  }
}

/**
 * Produce a series where buckets at given indices have the given count.
 * Empty buckets are sparse-encoded (omitted).
 */
function series(
  kind: LatencySeriesFact['kind'],
  key: string,
  spikeBuckets: Array<{ idx: number; count: number }>,
): LatencySeriesFact[] {
  return spikeBuckets.map(b => ({
    kind, key, bucketIdx: b.idx, count: b.count, meanLatencyMs: 50,
  }))
}

describe('grangerRuntime', () => {
  it('returns empty when latencySeries is undefined', () => {
    const s: RuntimeSnapshot = {
      symbolsTouched: [], httpRouteHits: [], dbQueriesExecuted: [],
      redisOps: [], eventsEmitted: [], callEdges: [],
      meta: { driver: 'test', startedAtUnix: 0, durationMs: 0, totalSpans: 0 },
    }
    expect(grangerRuntime(s)).toEqual([])
  })

  it('returns empty when bucketCount is too small', () => {
    const s = snap([
      ...series('http-route', 'GET /a', [{ idx: 0, count: 5 }]),
    ], 1)
    expect(grangerRuntime(s)).toEqual([])
  })

  it('detects clear lag-1 driver→follower causation', () => {
    // A spikes at buckets 5,10,15,20 ; B spikes at buckets 6,11,16,21 (always lag+1)
    const driverIdx = [5, 10, 15, 20]
    const followerIdx = [6, 11, 16, 21]
    const facts = [
      ...series('http-route', 'GET /a', driverIdx.map(i => ({ idx: i, count: 10 }))),
      ...series('http-route', 'GET /b', followerIdx.map(i => ({ idx: i, count: 10 }))),
    ]
    const r = grangerRuntime(snap(facts))
    expect(r).toHaveLength(1)
    expect(r[0].driverSeries).toBe('http-route:GET /a')
    expect(r[0].followerSeries).toBe('http-route:GET /b')
    expect(r[0].observations).toBe(4)
    expect(r[0].excessConditionalX1000).toBeGreaterThan(800)               // ~1.0 - 0.066 ≈ 0.93
    expect(r[0].lagBuckets).toBe(1)
  })

  it('does not emit when excess is below threshold', () => {
    // A spikes 4× ; B spikes randomly at unrelated buckets — excess should be ~0
    const facts = [
      ...series('http-route', 'GET /a', [
        { idx: 5, count: 10 }, { idx: 10, count: 10 },
        { idx: 15, count: 10 }, { idx: 20, count: 10 },
      ]),
      ...series('http-route', 'GET /b', [
        { idx: 30, count: 10 }, { idx: 40, count: 10 }, { idx: 50, count: 10 },
      ]),
    ]
    const r = grangerRuntime(snap(facts))
    expect(r).toEqual([])
  })

  it('respects minObservations option', () => {
    // Only 2 spikes for A — below default minObservations=3
    const facts = [
      ...series('http-route', 'GET /a', [
        { idx: 5, count: 10 }, { idx: 10, count: 10 },
      ]),
      ...series('http-route', 'GET /b', [
        { idx: 6, count: 10 }, { idx: 11, count: 10 },
      ]),
    ]
    const r = grangerRuntime(snap(facts))
    expect(r).toEqual([])
  })

  it('does not pair series with itself', () => {
    const facts = [
      ...series('http-route', 'GET /a', [
        { idx: 5, count: 10 }, { idx: 6, count: 10 },
        { idx: 10, count: 10 }, { idx: 11, count: 10 },
        { idx: 15, count: 10 }, { idx: 16, count: 10 },
      ]),
    ]
    const r = grangerRuntime(snap(facts))
    for (const f of r) expect(f.driverSeries).not.toBe(f.followerSeries)
  })

  it('determinism : same input → same output', () => {
    const facts = [
      ...series('http-route', 'GET /a', [
        { idx: 5, count: 10 }, { idx: 10, count: 10 },
        { idx: 15, count: 10 }, { idx: 20, count: 10 },
      ]),
      ...series('http-route', 'GET /b', [
        { idx: 6, count: 10 }, { idx: 11, count: 10 },
        { idx: 16, count: 10 }, { idx: 21, count: 10 },
      ]),
    ]
    const a = grangerRuntime(snap(facts))
    const b = grangerRuntime(snap(facts))
    expect(a).toEqual(b)
  })
})

describe('grangerRuntimeFileRollup', () => {
  it('aggregates symbol-level Granger to file-level', () => {
    const facts: GrangerRuntimeFact[] = [
      {
        driverSeries: 'symbol:src/a.ts::foo',
        followerSeries: 'symbol:src/b.ts::bar',
        observations: 4,
        excessConditionalX1000: 800,
        lagBuckets: 1,
      },
      {
        driverSeries: 'symbol:src/a.ts::baz',
        followerSeries: 'symbol:src/b.ts::quux',
        observations: 3,
        excessConditionalX1000: 500,
        lagBuckets: 1,
      },
    ]
    const r = grangerRuntimeFileRollup(facts)
    expect(r).toHaveLength(1)
    expect(r[0].driverFile).toBe('src/a.ts')
    expect(r[0].followerFile).toBe('src/b.ts')
    expect(r[0].observations).toBe(7)                                       // 4+3 sum
    expect(r[0].maxExcessConditionalX1000).toBe(800)                        // max
  })

  it('skips non-symbol kinds', () => {
    const facts: GrangerRuntimeFact[] = [
      {
        driverSeries: 'http-route:GET /a',
        followerSeries: 'db-table:orders::SELECT',
        observations: 4,
        excessConditionalX1000: 800,
        lagBuckets: 1,
      },
    ]
    expect(grangerRuntimeFileRollup(facts)).toEqual([])
  })

  it('skips self-loops at file level (same driver/follower file)', () => {
    const facts: GrangerRuntimeFact[] = [
      {
        driverSeries: 'symbol:src/a.ts::foo',
        followerSeries: 'symbol:src/a.ts::bar',
        observations: 4,
        excessConditionalX1000: 800,
        lagBuckets: 1,
      },
    ]
    expect(grangerRuntimeFileRollup(facts)).toEqual([])
  })

  it('determinism: sorted by maxExcess desc then file names', () => {
    const facts: GrangerRuntimeFact[] = [
      {
        driverSeries: 'symbol:z.ts::a',
        followerSeries: 'symbol:y.ts::b',
        observations: 1,
        excessConditionalX1000: 300,
        lagBuckets: 1,
      },
      {
        driverSeries: 'symbol:a.ts::a',
        followerSeries: 'symbol:b.ts::b',
        observations: 1,
        excessConditionalX1000: 800,
        lagBuckets: 1,
      },
    ]
    const r = grangerRuntimeFileRollup(facts)
    expect(r[0].driverFile).toBe('a.ts')                                    // higher excess first
    expect(r[1].driverFile).toBe('z.ts')
  })
})
