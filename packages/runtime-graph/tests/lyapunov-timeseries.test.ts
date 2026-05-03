/**
 * Phase γ.2 time-series Lyapunov — unit tests.
 * Pure math on synthetic LatencySeries — no I/O, deterministic.
 */

import { describe, it, expect } from 'vitest'
import { lyapunovTimeseries } from '../src/metrics/lyapunov-timeseries.js'
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
 * Build a LatencySeries from an array of meanLatencyMs values, one per bucket.
 * Skip null entries (sparse — bucket empty).
 */
function fromValues(
  kind: LatencySeriesFact['kind'],
  key: string,
  values: Array<number | null>,
): LatencySeriesFact[] {
  const out: LatencySeriesFact[] = []
  values.forEach((v, idx) => {
    if (v === null) return
    out.push({ kind, key, bucketIdx: idx, count: 1, meanLatencyMs: v })
  })
  return out
}

describe('lyapunovTimeseries', () => {
  it('returns empty when latencySeries is undefined', () => {
    const s: RuntimeSnapshot = {
      symbolsTouched: [], httpRouteHits: [], dbQueriesExecuted: [],
      redisOps: [], eventsEmitted: [], callEdges: [],
      meta: { driver: 'test', startedAtUnix: 0, durationMs: 0, totalSpans: 0 },
    }
    expect(lyapunovTimeseries(s)).toEqual([])
  })

  it('returns empty when bucketCount < 3', () => {
    const facts = fromValues('http-route', 'GET /a', [100, 100])
    expect(lyapunovTimeseries(snap(facts, 2))).toEqual([])
  })

  it('skips series with fewer non-empty buckets than minObservations', () => {
    // Only 3 non-empty buckets in 60 — below default minObservations=5
    const facts = fromValues('http-route', 'GET /a',
      [100, 100, 100, ...Array(57).fill(null)])
    expect(lyapunovTimeseries(snap(facts))).toEqual([])
  })

  it('emits λ ≈ 0 for a constant series (no variation)', () => {
    // 60 buckets all at 100ms — σ = 0 → λ = 0 (handled as edge case)
    const values = Array<number>(60).fill(100)
    const facts = fromValues('http-route', 'GET /a', values)
    const r = lyapunovTimeseries(snap(facts))
    expect(r).toHaveLength(1)
    expect(r[0].kind).toBe('http-route')
    expect(r[0].key).toBe('GET /a')
    expect(r[0].lambdaX1000).toBe(0)
    expect(r[0].stdDevX1000).toBe(0)
  })

  it('emits low λ for a smoothly varying series', () => {
    // Linear ramp 100→160ms over 60 buckets — small consecutive deltas vs σ
    const values = Array.from({ length: 60 }, (_, i) => 100 + i)
    const facts = fromValues('http-route', 'GET /a', values)
    const r = lyapunovTimeseries(snap(facts))
    expect(r).toHaveLength(1)
    expect(r[0].lambdaX1000).toBeLessThan(200)                              // < 0.2 — smooth
  })

  it('emits high λ for a wildly oscillating series', () => {
    // Alternating 50ms / 500ms — consecutive delta ~450, σ ~225 → d = 2 → λ = log(3) ≈ 1.1
    const values: number[] = []
    for (let i = 0; i < 60; i++) values.push(i % 2 === 0 ? 50 : 500)
    const facts = fromValues('http-route', 'GET /a', values)
    const r = lyapunovTimeseries(snap(facts))
    expect(r).toHaveLength(1)
    expect(r[0].lambdaX1000).toBeGreaterThan(700)                           // chaotic regime
  })

  it('uses count metric when option set', () => {
    // values constant in latency, varying in count — should detect variation
    const facts: LatencySeriesFact[] = []
    for (let i = 0; i < 60; i++) {
      facts.push({
        kind: 'http-route', key: 'GET /a',
        bucketIdx: i,
        count: i % 2 === 0 ? 1 : 100,
        meanLatencyMs: 100,                                                  // constant
      })
    }
    const meanResult = lyapunovTimeseries(snap(facts), { metric: 'meanLatencyMs' })
    const countResult = lyapunovTimeseries(snap(facts), { metric: 'count' })
    // meanLatencyMs is constant → λ = 0
    expect(meanResult[0].lambdaX1000).toBe(0)
    // count oscillates wildly → λ > 0
    expect(countResult[0].lambdaX1000).toBeGreaterThan(500)
  })

  it('determinism : same input → same output', () => {
    const values = Array.from({ length: 60 }, (_, i) => i % 3 === 0 ? 200 : 100)
    const facts = fromValues('http-route', 'GET /a', values)
    const a = lyapunovTimeseries(snap(facts))
    const b = lyapunovTimeseries(snap(facts))
    expect(a).toEqual(b)
  })

  it('sorts results by lambda desc', () => {
    const facts: LatencySeriesFact[] = [
      // smooth series
      ...fromValues('http-route', 'GET /smooth',
        Array.from({ length: 60 }, (_, i) => 100 + i)),
      // chaotic series
      ...fromValues('http-route', 'GET /chaotic',
        Array.from({ length: 60 }, (_, i) => i % 2 === 0 ? 50 : 500)),
    ]
    const r = lyapunovTimeseries(snap(facts))
    expect(r).toHaveLength(2)
    expect(r[0].key).toBe('GET /chaotic')                                   // higher λ first
    expect(r[1].key).toBe('GET /smooth')
  })
})
