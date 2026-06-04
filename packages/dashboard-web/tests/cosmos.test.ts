// ADR-032 — tests du renderer cosmos (fonctions pures de transformation).
/**
 * Couvre `buildDatasetFromSnapshot` (transfo SnapshotPayload → CosmosDataset)
 * et transitivement `layoutNodes` (positionnement force-directed). Le rendu
 * canvas n'est pas testé ici — seules les fonctions data/layout déterministes
 * en structure le sont. Comble le gap : cosmos.ts n'avait aucun test.
 */

import { describe, it, expect } from 'vitest'
import {
  buildDatasetFromSnapshot,
  edgeAlphaForZoom,
  edgeLodStep,
  edgeIsCulled,
  buildAdjacency,
  screenToWorld,
  pickNode,
  applyZoomAt,
  frameCamera,
} from '../src/lib/cosmos.js'
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

describe('cosmos rendering helpers (purs)', () => {
  it('edgeAlphaForZoom : paliers selon le zoom', () => {
    expect(edgeAlphaForZoom(0.2)).toBe(0.04)
    expect(edgeAlphaForZoom(0.6)).toBe(0.08)
    expect(edgeAlphaForZoom(1.0)).toBe(0.13)
  })

  it('edgeLodStep : skip plus agressif en zoom-out', () => {
    expect(edgeLodStep(0.6)).toBe(1)
    expect(edgeLodStep(0.4)).toBe(2)
    expect(edgeLodStep(0.2)).toBe(4)
  })

  it('edgeIsCulled : cull si les 2 extrémités sont du même côté hors viewport', () => {
    const vp = { wx0: 0, wx1: 100, wy0: 0, wy1: 100 }
    // les 2 à gauche de wx0 → cull
    expect(edgeIsCulled({ x: -10, y: 50 }, { x: -5, y: 50 }, vp)).toBe(true)
    // les 2 au-dessus de wy1 → cull
    expect(edgeIsCulled({ x: 50, y: 200 }, { x: 50, y: 150 }, vp)).toBe(true)
    // une dedans, une dehors → pas cull (traverse le viewport)
    expect(edgeIsCulled({ x: 50, y: 50 }, { x: -200, y: 50 }, vp)).toBe(false)
    // les 2 dedans → pas cull
    expect(edgeIsCulled({ x: 20, y: 20 }, { x: 80, y: 80 }, vp)).toBe(false)
  })

  it('buildAdjacency : non-dirigée, voisins des 2 côtés', () => {
    const adj = buildAdjacency([{ s: 0, t: 1 }, { s: 1, t: 2 }])
    expect([...(adj.get(1) ?? [])].sort()).toEqual([0, 2])
    expect([...(adj.get(0) ?? [])]).toEqual([1])
  })

  it('screenToWorld est l\'inverse du transform caméra', () => {
    const cam = { x: 100, y: 50, zoom: 2, targetZoom: 2 }
    // au centre écran (w/2,h/2) → (cam.x, cam.y)
    expect(screenToWorld(400, 300, cam, 800, 600)).toEqual({ wx: 100, wy: 50 })
  })

  it('pickNode : node le plus proche dans le rayon, sinon null', () => {
    const nodes = buildDatasetFromSnapshot(snap([{ id: 'a' }, { id: 'b' }], [])).nodes
    nodes[0].x = 0; nodes[0].y = 0
    nodes[1].x = 100; nodes[1].y = 0
    expect(pickNode(nodes, 5, 0, 14)?.id).toBe(0)   // proche de a
    expect(pickNode(nodes, 50, 0, 14)).toBeNull()    // trop loin des deux
  })

  it('applyZoomAt : zoom borné [0.05,5] + garde le point sous le curseur', () => {
    const cam = { x: 0, y: 0, zoom: 1, targetZoom: 1 }
    applyZoomAt(cam, 400, 300, -100, 800, 600) // molette vers le haut = zoom in
    expect(cam.zoom).toBeGreaterThan(1)
    expect(cam.zoom).toBeLessThanOrEqual(5)
    // curseur au centre écran → le centre monde ne bouge pas
    expect(cam.x).toBeCloseTo(0, 6)
    expect(cam.y).toBeCloseTo(0, 6)
  })

  it('frameCamera : null si vide, sinon centre + zoom finis', () => {
    expect(frameCamera([], 800, 600)).toBeNull()
    const nodes = buildDatasetFromSnapshot(snap([{ id: 'a' }, { id: 'b' }], [])).nodes
    nodes[0].x = -100; nodes[0].y = -100
    nodes[1].x = 100; nodes[1].y = 100
    const f = frameCamera(nodes, 800, 600)!
    expect(f.x).toBe(0)
    expect(f.y).toBe(0)
    expect(Number.isFinite(f.zoom)).toBe(true)
  })
})
