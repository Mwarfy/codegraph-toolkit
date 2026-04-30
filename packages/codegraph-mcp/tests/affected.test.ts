/**
 * Test de l'algorithme reverse-deps BFS de affected.ts.
 * Construit des snapshots fixture et vérifie le calcul.
 */

import { describe, it, expect } from 'vitest'
import { computeAffected } from '../src/tools/affected.js'

function makeSnapshot(nodes: string[], edges: Array<[string, string, string?]>) {
  return {
    nodes: nodes.map((id) => ({ id, type: 'file' as const })),
    edges: edges.map(([from, to, type]) => ({ from, to, type: type ?? 'import' })),
  }
}

describe('computeAffected', () => {
  it('trouve les importeurs directs (depth 1)', () => {
    const snap = makeSnapshot(
      ['a.ts', 'b.ts', 'c.ts'],
      [['b.ts', 'a.ts'], ['c.ts', 'a.ts']],
    )
    const result = computeAffected(snap, ['a.ts'])
    expect(result.affectedFiles).toEqual(['a.ts', 'b.ts', 'c.ts'])
    expect(result.maxDepthReached).toBe(1)
    expect(result.unknownInputs).toEqual([])
  })

  it('propage transitivement (depth 2+)', () => {
    const snap = makeSnapshot(
      ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
      [['b.ts', 'a.ts'], ['c.ts', 'b.ts'], ['d.ts', 'c.ts']],
    )
    const result = computeAffected(snap, ['a.ts'])
    expect(result.affectedFiles).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts'])
    expect(result.maxDepthReached).toBe(3)
  })

  it('respecte maxDepth', () => {
    const snap = makeSnapshot(
      ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
      [['b.ts', 'a.ts'], ['c.ts', 'b.ts'], ['d.ts', 'c.ts']],
    )
    const result = computeAffected(snap, ['a.ts'], { maxDepth: 1 })
    expect(result.affectedFiles).toEqual(['a.ts', 'b.ts'])
    expect(result.maxDepthReached).toBe(1)
  })

  it('ne suit pas les edges non-import par défaut', () => {
    const snap = makeSnapshot(
      ['a.ts', 'b.ts', 'c.ts'],
      [['b.ts', 'a.ts', 'event'], ['c.ts', 'a.ts', 'import']],
    )
    const result = computeAffected(snap, ['a.ts'])
    expect(result.affectedFiles).toEqual(['a.ts', 'c.ts']) // b.ts skip car edge=event
  })

  it('inclut les edges indirects avec includeIndirect', () => {
    const snap = makeSnapshot(
      ['a.ts', 'b.ts', 'c.ts'],
      [['b.ts', 'a.ts', 'event'], ['c.ts', 'a.ts', 'import']],
    )
    const result = computeAffected(snap, ['a.ts'], { includeIndirect: true })
    expect(result.affectedFiles).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  it('détecte les unknown inputs', () => {
    const snap = makeSnapshot(['a.ts'], [])
    const result = computeAffected(snap, ['a.ts', 'unknown.ts'])
    expect(result.affectedFiles).toEqual(['a.ts'])
    expect(result.unknownInputs).toEqual(['unknown.ts'])
  })

  it('classifie les tests via regex', () => {
    const snap = makeSnapshot(
      ['src/foo.ts', 'tests/foo.test.ts', 'src/foo.spec.ts'],
      [['tests/foo.test.ts', 'src/foo.ts'], ['src/foo.spec.ts', 'src/foo.ts']],
    )
    const result = computeAffected(snap, ['src/foo.ts'])
    expect(result.affectedTests.sort()).toEqual([
      'src/foo.spec.ts',
      'tests/foo.test.ts',
    ])
  })

  it('gère plusieurs inputs (union)', () => {
    const snap = makeSnapshot(
      ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
      [['c.ts', 'a.ts'], ['d.ts', 'b.ts']],
    )
    const result = computeAffected(snap, ['a.ts', 'b.ts'])
    expect(result.affectedFiles.sort()).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts'])
  })

  it('gère les cycles sans boucle infinie', () => {
    const snap = makeSnapshot(
      ['a.ts', 'b.ts', 'c.ts'],
      [['b.ts', 'a.ts'], ['c.ts', 'b.ts'], ['a.ts', 'c.ts']],
    )
    const result = computeAffected(snap, ['a.ts'])
    expect(result.affectedFiles.sort()).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })
})
