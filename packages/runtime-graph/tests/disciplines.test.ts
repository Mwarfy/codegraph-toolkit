/**
 * Phase γ disciplines unit tests.
 * Test the math, not the I/O — pure functions on synthetic snapshots.
 */

import { describe, it, expect } from 'vitest'
import {
  hammingStaticRuntime,
  informationBottleneckRuntime,
  newmanGirvanRuntime,
  lyapunovRuntime,
  computeAllDisciplines,
  type StaticCallEdge,
} from '../src/metrics/runtime-disciplines.js'
import type { RuntimeSnapshot } from '../src/core/types.js'

const baseMeta = {
  driver: 'test',
  startedAtUnix: 1700000000,
  durationMs: 1000,
  totalSpans: 0,
}

function snap(opts: Partial<RuntimeSnapshot>): RuntimeSnapshot {
  return {
    symbolsTouched: opts.symbolsTouched ?? [],
    httpRouteHits: [],
    dbQueriesExecuted: [],
    redisOps: [],
    eventsEmitted: [],
    callEdges: opts.callEdges ?? [],
    meta: opts.meta ?? baseMeta,
  }
}

describe('hammingStaticRuntime', () => {
  it('returns 0 distance when static and runtime edges are identical', () => {
    const edges: StaticCallEdge[] = [
      { fromFile: 'a.ts', fromFn: 'foo', toFile: 'b.ts', toFn: 'bar' },
    ]
    const s = snap({
      callEdges: [{ fromFile: 'a.ts', fromFn: 'foo', toFile: 'b.ts', toFn: 'bar', count: 1 }],
    })
    const r = hammingStaticRuntime(s, edges)
    expect(r.distance).toBe(0)
    expect(r.staticOnly).toBe(0)
    expect(r.runtimeOnly).toBe(0)
    expect(r.total).toBe(1)
  })

  it('returns 1 distance when edges totally diverge', () => {
    const edges: StaticCallEdge[] = [
      { fromFile: 'a.ts', fromFn: 'foo', toFile: 'b.ts', toFn: 'bar' },
    ]
    const s = snap({
      callEdges: [{ fromFile: 'x.ts', fromFn: 'baz', toFile: 'y.ts', toFn: 'qux', count: 1 }],
    })
    const r = hammingStaticRuntime(s, edges)
    expect(r.distance).toBe(1)
    expect(r.staticOnly).toBe(1)
    expect(r.runtimeOnly).toBe(1)
    expect(r.total).toBe(2)
  })

  it('handles 50% overlap', () => {
    const edges: StaticCallEdge[] = [
      { fromFile: 'a.ts', fromFn: 'fn1', toFile: 'b.ts', toFn: 'g' },
      { fromFile: 'a.ts', fromFn: 'fn2', toFile: 'c.ts', toFn: 'h' },
    ]
    const s = snap({
      callEdges: [
        { fromFile: 'a.ts', fromFn: 'fn1', toFile: 'b.ts', toFn: 'g', count: 1 },        // shared
        { fromFile: 'a.ts', fromFn: 'fn3', toFile: 'd.ts', toFn: 'i', count: 1 },        // runtime only
      ],
    })
    const r = hammingStaticRuntime(s, edges)
    expect(r.staticOnly).toBe(1)
    expect(r.runtimeOnly).toBe(1)
    expect(r.total).toBe(3)                                            // 2/3 = 0.666
    expect(r.distance).toBeCloseTo(2 / 3, 5)
  })

  it('returns 0 for empty inputs', () => {
    const r = hammingStaticRuntime(snap({}), [])
    expect(r.distance).toBe(0)
    expect(r.total).toBe(0)
  })
})

describe('informationBottleneckRuntime', () => {
  it('flags symbols with high inflow and low outflow as bottleneck', () => {
    const s = snap({
      symbolsTouched: [
        { file: 'mid.ts', fn: 'compress', count: 10, p95LatencyMs: 5 },
      ],
      callEdges: [
        // 3 callers → mid.compress
        { fromFile: 'a.ts', fromFn: 'a1', toFile: 'mid.ts', toFn: 'compress', count: 1 },
        { fromFile: 'b.ts', fromFn: 'b1', toFile: 'mid.ts', toFn: 'compress', count: 1 },
        { fromFile: 'c.ts', fromFn: 'c1', toFile: 'mid.ts', toFn: 'compress', count: 1 },
        // 1 callee from mid.compress
        { fromFile: 'mid.ts', fromFn: 'compress', toFile: 'sink.ts', toFn: 's', count: 1 },
      ],
    })
    const r = informationBottleneckRuntime(s)
    expect(r).toHaveLength(1)
    expect(r[0].file).toBe('mid.ts')
    expect(r[0].inflow).toBe(3)
    expect(r[0].outflow).toBe(1)
    // score = 1 - 1/3 ≈ 0.666
    expect(r[0].bottleneckScore).toBeCloseTo(0.666, 2)
  })

  it('skips symbols without inflow (no callers = trivially terminal)', () => {
    const s = snap({
      symbolsTouched: [{ file: 'leaf.ts', fn: 'l', count: 1, p95LatencyMs: 5 }],
      callEdges: [],
    })
    const r = informationBottleneckRuntime(s)
    expect(r).toHaveLength(0)
  })

  it('returns score=1 when outflow=0 (terminal sink)', () => {
    const s = snap({
      symbolsTouched: [{ file: 'sink.ts', fn: 'consume', count: 5, p95LatencyMs: 5 }],
      callEdges: [
        { fromFile: 'a.ts', fromFn: 'caller', toFile: 'sink.ts', toFn: 'consume', count: 1 },
      ],
    })
    const r = informationBottleneckRuntime(s)
    expect(r).toHaveLength(1)
    expect(r[0].bottleneckScore).toBe(1)
  })
})

describe('newmanGirvanRuntime', () => {
  it('returns Q=0 with no edges', () => {
    const r = newmanGirvanRuntime(snap({}))
    expect(r.globalQ).toBe(0)
    expect(r.filesByModularity).toHaveLength(0)
  })

  it('high Q when edges concentrated within file (good modularity)', () => {
    const s = snap({
      symbolsTouched: [
        { file: 'a.ts', fn: 'f1', count: 1, p95LatencyMs: 1 },
        { file: 'a.ts', fn: 'f2', count: 1, p95LatencyMs: 1 },
        { file: 'b.ts', fn: 'g1', count: 1, p95LatencyMs: 1 },
        { file: 'b.ts', fn: 'g2', count: 1, p95LatencyMs: 1 },
      ],
      callEdges: [
        // intra-a only
        { fromFile: 'a.ts', fromFn: 'f1', toFile: 'a.ts', toFn: 'f2', count: 1 },
        // intra-b only
        { fromFile: 'b.ts', fromFn: 'g1', toFile: 'b.ts', toFn: 'g2', count: 1 },
      ],
    })
    const r = newmanGirvanRuntime(s)
    expect(r.globalQ).toBeGreaterThan(0.4)                             // high modularity
    expect(r.filesByModularity).toHaveLength(2)
  })

  it('low Q when edges cross files (poor modularity)', () => {
    const s = snap({
      symbolsTouched: [
        { file: 'a.ts', fn: 'f', count: 1, p95LatencyMs: 1 },
        { file: 'b.ts', fn: 'g', count: 1, p95LatencyMs: 1 },
        { file: 'c.ts', fn: 'h', count: 1, p95LatencyMs: 1 },
      ],
      callEdges: [
        // every file calls every other → 0 intra-file edges
        { fromFile: 'a.ts', fromFn: 'f', toFile: 'b.ts', toFn: 'g', count: 1 },
        { fromFile: 'b.ts', fromFn: 'g', toFile: 'c.ts', toFn: 'h', count: 1 },
        { fromFile: 'c.ts', fromFn: 'h', toFile: 'a.ts', toFn: 'f', count: 1 },
      ],
    })
    const r = newmanGirvanRuntime(s)
    expect(r.globalQ).toBeLessThan(0)                                   // negative Q = worse than random
  })

  it('output sorted by Q descending', () => {
    const s = snap({
      symbolsTouched: [
        { file: 'high.ts', fn: 'a', count: 1, p95LatencyMs: 1 },
        { file: 'high.ts', fn: 'b', count: 1, p95LatencyMs: 1 },
        { file: 'low.ts', fn: 'c', count: 1, p95LatencyMs: 1 },
        { file: 'mid.ts', fn: 'd', count: 1, p95LatencyMs: 1 },
        { file: 'mid.ts', fn: 'e', count: 1, p95LatencyMs: 1 },
      ],
      callEdges: [
        { fromFile: 'high.ts', fromFn: 'a', toFile: 'high.ts', toFn: 'b', count: 1 },
        { fromFile: 'mid.ts', fromFn: 'd', toFile: 'mid.ts', toFn: 'e', count: 1 },
        { fromFile: 'low.ts', fromFn: 'c', toFile: 'high.ts', toFn: 'a', count: 1 },
      ],
    })
    const r = newmanGirvanRuntime(s)
    // descending order
    for (let i = 1; i < r.filesByModularity.length; i++) {
      expect(r.filesByModularity[i - 1].q).toBeGreaterThanOrEqual(r.filesByModularity[i].q)
    }
  })
})

describe('lyapunovRuntime', () => {
  it('flags symbols with high p95 + sufficient sample size', () => {
    const s = snap({
      symbolsTouched: [
        { file: 'slow.ts', fn: 'fn', count: 100, p95LatencyMs: 1000 },
        { file: 'fast.ts', fn: 'fn', count: 100, p95LatencyMs: 5 },
      ],
    })
    const r = lyapunovRuntime(s)
    const slow = r.find(x => x.file === 'slow.ts')!
    const fast = r.find(x => x.file === 'fast.ts')!
    expect(slow.approxLambda).toBeGreaterThan(fast.approxLambda)
    expect(slow.approxLambda).toBeCloseTo(Math.log(1001), 3)
  })

  it('skips symbols with too few samples (count < 3)', () => {
    const s = snap({
      symbolsTouched: [
        { file: 'rare.ts', fn: 'fn', count: 2, p95LatencyMs: 5000 },
      ],
    })
    expect(lyapunovRuntime(s)).toHaveLength(0)
  })

  it('skips symbols with p95 = 0', () => {
    const s = snap({
      symbolsTouched: [
        { file: 'zero.ts', fn: 'fn', count: 100, p95LatencyMs: 0 },
      ],
    })
    expect(lyapunovRuntime(s)).toHaveLength(0)
  })
})

describe('computeAllDisciplines', () => {
  it('runs all four disciplines on a snapshot', () => {
    const s = snap({
      symbolsTouched: [
        { file: 'a.ts', fn: 'f', count: 5, p95LatencyMs: 100 },
        { file: 'b.ts', fn: 'g', count: 5, p95LatencyMs: 50 },
      ],
      callEdges: [
        { fromFile: 'a.ts', fromFn: 'f', toFile: 'b.ts', toFn: 'g', count: 1 },
      ],
    })
    const r = computeAllDisciplines(s, [
      { fromFile: 'a.ts', fromFn: 'f', toFile: 'b.ts', toFn: 'g' },
    ])
    expect(r.hamming).not.toBeNull()
    expect(r.hamming!.distance).toBe(0)
    expect(r.informationBottleneck.length).toBeGreaterThan(0)
    expect(r.newmanGirvan.globalQ).toBeDefined()
    expect(r.lyapunov.length).toBeGreaterThan(0)
  })

  it('hamming = null when no static edges provided', () => {
    const r = computeAllDisciplines(snap({}), [])
    expect(r.hamming).toBeNull()
  })
})
