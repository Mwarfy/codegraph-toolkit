// ADR-032 — tests du renderer cosmos (fonctions pures de transformation).
/**
 * Couvre `buildDatasetFromSnapshot` (transfo SnapshotPayload → CosmosDataset)
 * et transitivement `layoutNodes` (positionnement force-directed). Le rendu
 * canvas n'est pas testé ici — seules les fonctions data/layout déterministes
 * en structure le sont. Comble le gap : cosmos.ts n'avait aucun test.
 */

import { describe, it, expect } from 'vitest'
import { buildDatasetFromSnapshot } from '../src/lib/cosmos.js'
import type { SnapshotPayload } from '../src/lib/api.js'

function snap(
  nodes: Array<{ id: string; label?: string; tags?: string[] }>,
  edges: Array<{ from: string; to: string }>,
): SnapshotPayload {
  return {
    data: {
      nodes: nodes.map((n) => ({ id: n.id, label: n.label, tags: n.tags })),
      edges: edges.map((e, i) => ({ id: `e${i}`, from: e.from, to: e.to })),
    },
  } as unknown as SnapshotPayload
}

describe('buildDatasetFromSnapshot', () => {
  it('snapshot undefined → dataset vide', () => {
    const ds = buildDatasetFromSnapshot(undefined)
    expect(ds.nodes).toEqual([])
    expect(ds.edges).toEqual([])
    expect(ds.byId.size).toBe(0)
  })

  it('mappe les nodes avec id séquentiel + maps byApiId/byPath', () => {
    const ds = buildDatasetFromSnapshot(snap(
      [{ id: 'a', label: 'pkg/x/a.ts' }, { id: 'b', label: 'pkg/y/b.ts' }],
      [],
    ))
    expect(ds.nodes).toHaveLength(2)
    expect(ds.nodes.map((n) => n.id)).toEqual([0, 1])
    expect(ds.byApiId.get('a')?.path).toBe('pkg/x/a.ts')
    expect(ds.byPath.get('pkg/y/b.ts')?.apiId).toBe('b')
  })

  it('filtre les edges invalides (from/to inconnu) et les self-loops', () => {
    const ds = buildDatasetFromSnapshot(snap(
      [{ id: 'a', label: 'a.ts' }, { id: 'b', label: 'b.ts' }],
      [
        { from: 'a', to: 'b' },       // valide
        { from: 'a', to: 'ghost' },   // to inconnu → drop
        { from: 'a', to: 'a' },       // self-loop → drop
      ],
    ))
    expect(ds.edges).toHaveLength(1)
    expect(ds.edges[0]).toEqual({ s: 0, t: 1 })
  })

  it('marque le node le plus connecté comme hub (top 4%, min 1)', () => {
    // Star : a relié à b,c,d → degree(a)=3, autres=1. hubCount=1 → a hub.
    const ds = buildDatasetFromSnapshot(snap(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'a', to: 'd' }],
    ))
    expect(ds.byApiId.get('a')?.hub).toBe(true)
    expect(ds.byApiId.get('b')?.hub).toBe(false)
  })

  it('un tag hub/truth-point force hub=true', () => {
    const ds = buildDatasetFromSnapshot(snap(
      [{ id: 'a', tags: ['truth-point'] }, { id: 'b' }],
      [],
    ))
    expect(ds.byApiId.get('a')?.hub).toBe(true)
  })

  it('layout : tous les nodes reçoivent des coordonnées finies', () => {
    const ds = buildDatasetFromSnapshot(snap(
      [{ id: 'a', label: 'p/a.ts' }, { id: 'b', label: 'p/b.ts' }, { id: 'c', label: 'q/c.ts' }],
      [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
    ))
    for (const n of ds.nodes) {
      expect(Number.isFinite(n.x)).toBe(true)
      expect(Number.isFinite(n.y)).toBe(true)
    }
  })
})
