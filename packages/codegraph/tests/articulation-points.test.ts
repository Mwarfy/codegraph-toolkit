/**
 * Tests pour articulation-points (Phase 4 Tier 5).
 *
 * Algo Tarjan O(V+E) sur graphe non-dirigé d'imports.
 */

import { describe, it, expect } from 'vitest'
import { findArticulationPoints } from '../src/extractors/articulation-points.js'

function snap(nodes: string[], edges: Array<[string, string]>) {
  return {
    nodes: nodes.map((id) => ({ id })),
    edges: edges.map(([from, to]) => ({ from, to, type: 'import' })),
  }
}

describe('articulation-points', () => {
  it('détecte un cut-vertex dans un graphe linéaire A-B-C', () => {
    // A -- B -- C : retirer B déconnecte A et C.
    const { nodes, edges } = snap(['A', 'B', 'C'], [['A', 'B'], ['B', 'C']])
    const aps = findArticulationPoints(nodes, edges)
    expect(aps.map((a) => a.file)).toEqual(['B'])
    expect(aps[0].severity).toBe(2)  // 2 composantes après retrait
  })

  it('ne flag pas les feuilles', () => {
    const { nodes, edges } = snap(['A', 'B', 'C'], [['A', 'B'], ['B', 'C']])
    const aps = findArticulationPoints(nodes, edges)
    expect(aps.map((a) => a.file)).not.toContain('A')
    expect(aps.map((a) => a.file)).not.toContain('C')
  })

  it('détecte plusieurs cut-vertices dans une chaine étendue', () => {
    // A - B - C - D - E : B, C, D sont tous articulation.
    const { nodes, edges } = snap(
      ['A', 'B', 'C', 'D', 'E'],
      [['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'E']],
    )
    const aps = findArticulationPoints(nodes, edges)
    expect(aps.map((a) => a.file).sort()).toEqual(['B', 'C', 'D'])
  })

  it('ne flag rien dans un graphe complet (cycle K3)', () => {
    // Triangle A-B-C-A : aucun cut-vertex.
    const { nodes, edges } = snap(
      ['A', 'B', 'C'],
      [['A', 'B'], ['B', 'C'], ['C', 'A']],
    )
    const aps = findArticulationPoints(nodes, edges)
    expect(aps).toEqual([])
  })

  it('détecte le cut-vertex d\\u0027un graphe en cloche', () => {
    // A-B + B-C-D + B-E (B est articulation : retirer B isole A, [C-D],
    // E en 3 composantes).
    const { nodes, edges } = snap(
      ['A', 'B', 'C', 'D', 'E'],
      [['A', 'B'], ['B', 'C'], ['C', 'D'], ['B', 'E']],
    )
    const aps = findArticulationPoints(nodes, edges)
    const aMap = new Map(aps.map((a) => [a.file, a.severity]))
    expect(aMap.get('B')).toBe(3)  // 3 composantes après retrait B
    expect(aMap.has('C')).toBe(true)  // C aussi (isole D)
  })

  it('graphe avec composantes connexes séparées', () => {
    // Deux clusters disconnectés : A-B-C et D-E. Aucun cut-vertex
    // car déjà 2 composantes au départ. Mais si on retire B, on
    // passe à 3 composantes (A, C, D-E).
    const { nodes, edges } = snap(
      ['A', 'B', 'C', 'D', 'E'],
      [['A', 'B'], ['B', 'C'], ['D', 'E']],
    )
    const aps = findArticulationPoints(nodes, edges)
    expect(aps.map((a) => a.file)).toEqual(['B'])
  })

  it('retourne une liste vide si pas d\\u0027edges', () => {
    const { nodes, edges } = snap(['A', 'B', 'C'], [])
    const aps = findArticulationPoints(nodes, edges)
    expect(aps).toEqual([])
  })

  it('skip les edges non-import par défaut', () => {
    const nodes = [{ id: 'A' }, { id: 'B' }, { id: 'C' }]
    const edges = [
      { from: 'A', to: 'B', type: 'event' },   // skip
      { from: 'B', to: 'C', type: 'event' },   // skip
    ]
    const aps = findArticulationPoints(nodes, edges)
    expect(aps).toEqual([])
  })

  it('inclut event/queue avec includeIndirect=true', () => {
    const nodes = [{ id: 'A' }, { id: 'B' }, { id: 'C' }]
    const edges = [
      { from: 'A', to: 'B', type: 'event' },
      { from: 'B', to: 'C', type: 'event' },
    ]
    const aps = findArticulationPoints(nodes, edges, { includeIndirect: true })
    expect(aps.map((a) => a.file)).toEqual(['B'])
  })

  it('tri par severity descending', () => {
    // B isole 4 components, C isole 2. B doit venir avant C.
    const { nodes, edges } = snap(
      ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
      [
        ['A', 'B'], ['B', 'C'], ['B', 'D'], ['B', 'E'], ['B', 'F'],
        ['F', 'G'],
      ],
    )
    const aps = findArticulationPoints(nodes, edges)
    expect(aps[0].file).toBe('B')
    expect(aps[0].severity).toBeGreaterThan(aps[aps.length - 1].severity)
  })
})
