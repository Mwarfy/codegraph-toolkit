/**
 * Phase γ.2c TDA persistence — unit tests.
 * Pure math on synthetic call graphs — no I/O, deterministic.
 */

import { describe, it, expect } from 'vitest'
import { tdaPersistence } from '../src/metrics/tda-persistence.js'
import type { CallEdgeRuntimeFact, RuntimeSnapshot } from '../src/core/types.js'

const baseMeta = {
  driver: 'test',
  startedAtUnix: 1700000000,
  durationMs: 1000,
  totalSpans: 0,
}

function snap(callEdges: CallEdgeRuntimeFact[]): RuntimeSnapshot {
  return {
    symbolsTouched: [],
    httpRouteHits: [],
    dbQueriesExecuted: [],
    redisOps: [],
    eventsEmitted: [],
    callEdges,
    meta: baseMeta,
  }
}

function edge(fromFile: string, toFile: string, count: number): CallEdgeRuntimeFact {
  return { fromFile, fromFn: 'f', toFile, toFn: 'g', count }
}

describe('tdaPersistence', () => {
  it('returns empty when no call edges', () => {
    expect(tdaPersistence(snap([]))).toEqual([])
  })

  it('returns empty when only self-edges (file→same file)', () => {
    const edges = [edge('a.ts', 'a.ts', 100)]
    expect(tdaPersistence(snap(edges))).toEqual([])
  })

  it('returns empty for a single edge between 2 files (size-2 cluster, persistence 0)', () => {
    // Single edge → 2 nodes merge at edge-count, both born at same edge.
    // Dying side persistence = 0 (born and died at same threshold).
    // With minPersistence=1 (default), nothing emitted.
    const edges = [edge('a.ts', 'b.ts', 100)]
    expect(tdaPersistence(snap(edges))).toEqual([])
  })

  it('detects two robust clusters bridged by a weak edge', () => {
    // Cluster 1 : a-b-c with internal edges count=100
    // Cluster 2 : x-y-z with internal edges count=80
    // Bridge   : c-x with count=2
    //
    // Filtration desc :
    //   t=100 : a-b, b-c → cluster {a,b,c} (size 3)
    //   t=80  : x-y, y-z → cluster {x,y,z} (size 3)
    //   t=2   : c-x → merge → smaller cluster dies, persistence ≈ 80-2=78
    const edges: CallEdgeRuntimeFact[] = [
      edge('a.ts', 'b.ts', 100),
      edge('b.ts', 'c.ts', 100),
      edge('x.ts', 'y.ts', 80),
      edge('y.ts', 'z.ts', 80),
      edge('c.ts', 'x.ts', 2),
    ]
    const r = tdaPersistence(snap(edges))
    // At least one persistent component (the dying cluster).
    expect(r.length).toBeGreaterThanOrEqual(1)
    // The most persistent should have persistence ≈ 80-2 = 78
    expect(r[0].persistence).toBeGreaterThan(50)
    expect(r[0].size).toBeGreaterThanOrEqual(2)
  })

  it('respects minPersistence option', () => {
    const edges: CallEdgeRuntimeFact[] = [
      edge('a.ts', 'b.ts', 100),
      edge('c.ts', 'd.ts', 99),
      edge('b.ts', 'c.ts', 1),
    ]
    // Default minPersistence=1
    const defaultResult = tdaPersistence(snap(edges))
    // Strict minPersistence=200 — nothing should fire
    const strictResult = tdaPersistence(snap(edges), { minPersistence: 200 })
    expect(strictResult).toEqual([])
    expect(defaultResult.length).toBeGreaterThan(0)
  })

  it('determinism : same input → same output', () => {
    const edges: CallEdgeRuntimeFact[] = [
      edge('a.ts', 'b.ts', 100),
      edge('c.ts', 'd.ts', 50),
      edge('a.ts', 'c.ts', 5),
    ]
    const a = tdaPersistence(snap(edges))
    const b = tdaPersistence(snap(edges))
    expect(a).toEqual(b)
  })

  it('sorts by persistence desc', () => {
    // Build a graph with 3 dying clusters of varying persistence.
    const edges: CallEdgeRuntimeFact[] = [
      // Cluster 1 : tightly bound, dies at ~5 (persistence ≈ 95)
      edge('a.ts', 'b.ts', 100),
      // Cluster 2 : moderately bound, dies at ~3 (persistence ≈ 47)
      edge('c.ts', 'd.ts', 50),
      // Cluster 3 : weakly bound, dies at ~1 (persistence ≈ 9)
      edge('e.ts', 'f.ts', 10),
      // Bridges (count desc determines merge order)
      edge('b.ts', 'c.ts', 5),
      edge('d.ts', 'e.ts', 3),
      edge('f.ts', 'a.ts', 1),
    ]
    const r = tdaPersistence(snap(edges))
    // Ordered by persistence desc
    for (let i = 0; i + 1 < r.length; i++) {
      expect(r[i].persistence).toBeGreaterThanOrEqual(r[i + 1].persistence)
    }
  })

  it('aggregates multi-edges between same file pair (sum counts)', () => {
    // 3 distinct symbol-level edges between same 2 files → file-level count
    // = 3+5+7 = 15. Pair with a second real cluster (c-d count=12), bridged
    // by weak edge a-c count=1. The younger cluster {c,d} (birth=12) dies
    // at the bridge → persistence = 12 - 1 = 11.
    const edges: CallEdgeRuntimeFact[] = [
      // Cluster {a,b} : 3 multi-edges aggregating to count=15
      { fromFile: 'a.ts', fromFn: 'f1', toFile: 'b.ts', toFn: 'g1', count: 3 },
      { fromFile: 'a.ts', fromFn: 'f2', toFile: 'b.ts', toFn: 'g2', count: 5 },
      { fromFile: 'a.ts', fromFn: 'f3', toFile: 'b.ts', toFn: 'g3', count: 7 },
      // Cluster {c,d} : single edge count=12
      edge('c.ts', 'd.ts', 12),
      // Bridge between clusters, weak count=1
      edge('a.ts', 'c.ts', 1),
    ]
    const r = tdaPersistence(snap(edges))
    // Expect the younger cluster {c,d} (birth=12) to die at 1 → persistence=11
    const robust = r.find(c => c.persistence === 11)
    expect(robust).toBeDefined()
  })

  it('includeSurviving option emits the final infinite component', () => {
    const edges = [edge('a.ts', 'b.ts', 100)]
    const r = tdaPersistence(snap(edges), { includeSurviving: true, minPersistence: 0 })
    // Expect a "surviving" entry (persistence=0, deathCount=0) representing
    // the final unmerged cluster.
    const surviving = r.find(c => c.deathCount === 0)
    expect(surviving).toBeDefined()
  })
})
