/**
 * Spectral graph determinism — regression test for the Math.random() bug
 * fixed in `extractors/spectral-graph.ts` (replaced by van der Corput).
 *
 * Pourquoi ce test :
 *   Le test `analyze-determinism-e2e.test.ts` tourne sur des fixtures
 *   de 8 fichiers à plat où `scopeOf()` regroupe par 3 segments path,
 *   donc chaque fichier finit dans son propre scope = 1 node, donc
 *   l'extracteur skip via `if (files.length < 3) continue`. Le random
 *   n'entrait jamais dans le hash → bug not caught.
 *
 *   Ce test passe un graph SYNTHÉTIQUE de 5 nodes dans le MÊME scope,
 *   ce qui force l'algo power-iteration à tourner. Si Math.random()
 *   était utilisé, λ₂ serait différent à chaque run.
 */

import { describe, it, expect } from 'vitest'
import { computeSpectralMetrics } from '../src/extractors/spectral-graph.js'
import type { GraphNode, GraphEdge } from '../src/core/types.js'

describe('spectral graph determinism (Math.random() regression)', () => {
  it('same input → byte-equivalent λ₂ across 10 runs', () => {
    // 5 files in the same 3-segment-path scope (`pkg/foo/src`).
    // scopeOf() takes first 3 segments, so files like `pkg/foo/src/X.ts`
    // all share scope `pkg/foo/src` → power iteration triggers.
    const nodes: GraphNode[] = [
      { id: 'pkg/foo/src/foo.ts', label: 'foo.ts', type: 'file', status: 'connected', parent: 'pkg/foo/src', tags: [], loc: 50 },
      { id: 'pkg/foo/src/bar.ts', label: 'bar.ts', type: 'file', status: 'connected', parent: 'pkg/foo/src', tags: [], loc: 50 },
      { id: 'pkg/foo/src/baz.ts', label: 'baz.ts', type: 'file', status: 'connected', parent: 'pkg/foo/src', tags: [], loc: 50 },
      { id: 'pkg/foo/src/qux.ts', label: 'qux.ts', type: 'file', status: 'connected', parent: 'pkg/foo/src', tags: [], loc: 50 },
      { id: 'pkg/foo/src/zog.ts', label: 'zog.ts', type: 'file', status: 'connected', parent: 'pkg/foo/src', tags: [], loc: 50 },
    ]
    const edges: GraphEdge[] = [
      { from: 'pkg/foo/src/foo.ts', to: 'pkg/foo/src/bar.ts', type: 'import' },
      { from: 'pkg/foo/src/bar.ts', to: 'pkg/foo/src/baz.ts', type: 'import' },
      { from: 'pkg/foo/src/baz.ts', to: 'pkg/foo/src/qux.ts', type: 'import' },
      { from: 'pkg/foo/src/qux.ts', to: 'pkg/foo/src/zog.ts', type: 'import' },
      { from: 'pkg/foo/src/foo.ts', to: 'pkg/foo/src/qux.ts', type: 'import' },
    ]

    const reference = JSON.stringify(computeSpectralMetrics(nodes, edges))
    expect(reference).not.toBe('[]')                                        // sanity : we got a result
    for (let i = 0; i < 10; i++) {
      expect(JSON.stringify(computeSpectralMetrics(nodes, edges))).toBe(reference)
    }
  })

  it('λ₂ is a known finite positive number (not NaN, not Math.random spread)', () => {
    const nodes: GraphNode[] = Array.from({ length: 6 }, (_, i) => ({
      id: `pkg/foo/src/n${i}.ts`,
      label: `n${i}.ts`,
      type: 'file' as const,
      status: 'connected' as const,
      parent: 'pkg/foo/src',
      tags: [],
      loc: 30,
    }))
    // Linear chain : 0→1→2→3→4→5 (path graph)
    const edges: GraphEdge[] = []
    for (let i = 0; i < 5; i++) {
      edges.push({ from: nodes[i].id, to: nodes[i + 1].id, type: 'import' })
    }

    const result = computeSpectralMetrics(nodes, edges)
    expect(result.length).toBeGreaterThan(0)
    for (const m of result) {
      expect(Number.isFinite(m.fiedlerX1000)).toBe(true)
      expect(m.fiedlerX1000).toBeGreaterThanOrEqual(0)
    }
  })
})
