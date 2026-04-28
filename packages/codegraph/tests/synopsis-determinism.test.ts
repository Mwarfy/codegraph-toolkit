/**
 * Determinism contract — ADR-009 (préservé depuis Sentinel).
 *
 * Le builder synopsis doit être PUR : même snapshot → même output byte-équivalent.
 * Aucun horodatage, aucun random, aucun I/O. 10 invocations doivent produire
 * exactement la même chaîne JSON.
 *
 * Si ce test pète, un raccourci impur s'est introduit dans le builder ou un
 * de ses helpers (ex: `Math.random()`, `Date.now()`, ordre de clés non-déter-
 * ministe via `for...in`, lecture de fichier, etc.).
 */

import { describe, it, expect } from 'vitest'
import { buildSynopsis } from '../src/synopsis/builder.js'
import type { GraphSnapshot } from '../src/core/types.js'

function syntheticSnapshot(): GraphSnapshot {
  return {
    version: '1',
    generatedAt: '2026-01-01T00:00:00.000Z',
    rootDir: '/tmp/fixture',
    nodes: [
      {
        id: 'src/foo.ts',
        label: 'foo.ts',
        type: 'file',
        status: 'connected',
        parent: 'src',
        tags: [],
        loc: 42,
      },
      {
        id: 'src/bar.ts',
        label: 'bar.ts',
        type: 'file',
        status: 'connected',
        parent: 'src',
        tags: ['hub'],
        loc: 100,
      },
      {
        id: 'src/orphan.ts',
        label: 'orphan.ts',
        type: 'file',
        status: 'orphan',
        parent: 'src',
        tags: [],
        loc: 10,
      },
    ],
    edges: [
      { from: 'src/foo.ts', to: 'src/bar.ts', type: 'import' },
      { from: 'src/bar.ts', to: 'src/foo.ts', type: 'import' },
    ],
    stats: {
      totalFiles: 3,
      totalEdges: 2,
      orphanCount: 1,
      connectedCount: 2,
      entryPointCount: 0,
      uncertainCount: 0,
      edgesByType: {
        import: 2,
        event: 0,
        route: 0,
        queue: 0,
        'dynamic-load': 0,
        'db-table': 0,
      },
      healthScore: 0.66,
    },
  }
}

describe('synopsis builder — determinism (ADR-009)', () => {
  it('produit le même JSON byte-pour-byte sur 10 invocations', () => {
    const snap = syntheticSnapshot()
    const reference = JSON.stringify(buildSynopsis(snap))

    for (let i = 0; i < 10; i++) {
      const out = JSON.stringify(buildSynopsis(snap))
      expect(out).toBe(reference)
    }
  })

  it('respecte les options sans introduire de variance', () => {
    const snap = syntheticSnapshot()
    const opts = { hubThreshold: 5 }
    const a = JSON.stringify(buildSynopsis(snap, opts))
    const b = JSON.stringify(buildSynopsis(snap, opts))
    expect(a).toBe(b)
  })
})
