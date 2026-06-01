// ADR-005
/**
 * Tests pour le cœur pur de `cli/commands/affected.ts` — BFS reverse depuis
 * des fichiers modifiés vers tout ce qui les importe transitivement.
 *
 * Stratégie : snapshots synthétiques minimaux où l'ensemble affecté est
 * dérivable à la main (direction edge : from importe to).
 */

import { describe, it, expect } from 'vitest'
import { computeAffected } from '../src/cli/commands/affected.js'

function snap(opts: {
  files: string[]
  edges?: Array<{ from: string; to: string; type?: string }>
}): unknown {
  return {
    nodes: opts.files.map((id) => ({ id })),
    edges: (opts.edges ?? []).map((e) => ({ from: e.from, to: e.to, type: e.type ?? 'import' })),
  }
}

describe('computeAffected — BFS reverse', () => {
  it('remonte les importers directs du fichier modifié', () => {
    // a.ts importe b.ts → modifier b.ts affecte a.ts.
    const s = snap({ files: ['a.ts', 'b.ts'], edges: [{ from: 'a.ts', to: 'b.ts' }] })
    const r = computeAffected(s, ['b.ts'], {})
    expect(r.affectedFiles.sort()).toEqual(['a.ts', 'b.ts'])
  })

  it('remonte transitivement (chaîne d\'imports)', () => {
    // a → b → c. Modifier c affecte b puis a.
    const s = snap({
      files: ['a.ts', 'b.ts', 'c.ts'],
      edges: [{ from: 'a.ts', to: 'b.ts' }, { from: 'b.ts', to: 'c.ts' }],
    })
    const r = computeAffected(s, ['c.ts'], {})
    expect(r.affectedFiles.sort()).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  it('respecte maxDepth', () => {
    const s = snap({
      files: ['a.ts', 'b.ts', 'c.ts'],
      edges: [{ from: 'a.ts', to: 'b.ts' }, { from: 'b.ts', to: 'c.ts' }],
    })
    const r = computeAffected(s, ['c.ts'], { maxDepth: 1 })
    expect(r.affectedFiles.sort()).toEqual(['b.ts', 'c.ts']) // a.ts à depth 2 exclu
    expect(r.maxDepthReached).toBe(1)
  })

  it('includeIndirect inclut les edges event/queue/db-table', () => {
    const s = snap({
      files: ['x.ts', 'y.ts'],
      edges: [{ from: 'x.ts', to: 'y.ts', type: 'event' }],
    })
    const without = computeAffected(s, ['y.ts'], {})
    expect(without.affectedFiles).toEqual(['y.ts']) // x non remonté (edge non-import)

    const withIndirect = computeAffected(s, ['y.ts'], { includeIndirect: true })
    expect(withIndirect.affectedFiles.sort()).toEqual(['x.ts', 'y.ts'])
  })

  it('liste les inputs inconnus du graph', () => {
    const s = snap({ files: ['a.ts'], edges: [] })
    const r = computeAffected(s, ['ghost.ts'], {})
    expect(r.unknownInputs).toEqual(['ghost.ts'])
    expect(r.affectedFiles).toEqual([])
  })

  it('isole les tests affectés', () => {
    const s = snap({
      files: ['b.ts', 'b.test.ts'],
      edges: [{ from: 'b.test.ts', to: 'b.ts' }],
    })
    const r = computeAffected(s, ['b.ts'], {})
    expect(r.affectedTests).toContain('b.test.ts')
  })
})
