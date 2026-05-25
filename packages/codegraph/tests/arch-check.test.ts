/**
 * Tests de `cli/commands/arch-check.ts` — focalisés sur la fonction pure
 * `evaluateRules`, extraite de `runArchCheckCommand` (refactor complexité :
 * cyclo 32 / cognitive 64 → orchestrateur + sous-fonctions).
 *
 * Caractérisation : ces tests documentent le comportement observable de
 * l'évaluation des règles `disallow` (single-hop) et `disallowReachable`
 * (transitif), indépendamment du I/O fichier et du rendu console.
 */

import { describe, it, expect } from 'vitest'
import { evaluateRules, type ArchRule } from '../src/cli/commands/arch-check.js'
import type { GraphEdge } from '../src/core/types.js'

function importEdge(from: string, to: string): GraphEdge {
  return { from, to, type: 'import' } as GraphEdge
}

describe('evaluateRules — arch-check rule evaluation (pure)', () => {
  it('détecte une violation directe pour une rule `disallow`', () => {
    const files = ['ui/a.ts', 'db/x.ts']
    const fileSet = new Set(files)
    const edges = [importEdge('ui/a.ts', 'db/x.ts')]
    const rules: ArchRule[] = [{ name: 'no-ui-to-db', from: 'ui/*', disallow: 'db/*' }]

    const violations = evaluateRules(rules, files, fileSet, edges)

    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({
      rule: 'no-ui-to-db',
      kind: 'direct',
      from: 'ui/a.ts',
      to: 'db/x.ts',
    })
  })

  it('détecte une violation transitive pour une rule `disallowReachable`', () => {
    const files = ['ui/a.ts', 'mid/b.ts', 'db/x.ts']
    const fileSet = new Set(files)
    const edges = [importEdge('ui/a.ts', 'mid/b.ts'), importEdge('mid/b.ts', 'db/x.ts')]
    const rules: ArchRule[] = [{ name: 'no-ui-reach-db', from: 'ui/*', disallowReachable: 'db/*' }]

    const violations = evaluateRules(rules, files, fileSet, edges)

    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({
      rule: 'no-ui-reach-db',
      kind: 'transitive',
      from: 'ui/a.ts',
      to: 'db/x.ts',
    })
    expect(violations[0].path).toEqual(['ui/a.ts', 'mid/b.ts', 'db/x.ts'])
  })

  it('ignore une rule dont le `from` ne matche aucun fichier', () => {
    const files = ['ui/a.ts', 'db/x.ts']
    const fileSet = new Set(files)
    const edges = [importEdge('ui/a.ts', 'db/x.ts')]
    const rules: ArchRule[] = [{ name: 'no-match', from: 'nope/*', disallow: 'db/*' }]

    expect(evaluateRules(rules, files, fileSet, edges)).toEqual([])
  })

  it('ignore une rule sans name ou sans from', () => {
    const files = ['ui/a.ts', 'db/x.ts']
    const fileSet = new Set(files)
    const edges = [importEdge('ui/a.ts', 'db/x.ts')]
    const rules = [{ from: 'ui/*', disallow: 'db/*' }, { name: 'x' }] as ArchRule[]

    expect(evaluateRules(rules, files, fileSet, edges)).toEqual([])
  })

  it('ignore les edges dont les extrémités sortent du fileSet', () => {
    const files = ['ui/a.ts', 'db/x.ts']
    const fileSet = new Set(files)
    // edge vers un fichier hors snapshot (ex: node_modules) → ignoré
    const edges = [importEdge('ui/a.ts', 'db/external.ts')]
    const rules: ArchRule[] = [{ name: 'r', from: 'ui/*', disallow: 'db/*' }]

    expect(evaluateRules(rules, files, fileSet, edges)).toEqual([])
  })

  it('propage la description quand présente', () => {
    const files = ['ui/a.ts', 'db/x.ts']
    const fileSet = new Set(files)
    const edges = [importEdge('ui/a.ts', 'db/x.ts')]
    const rules: ArchRule[] = [
      { name: 'r', description: 'no UI→DB', from: 'ui/*', disallow: 'db/*' },
    ]

    expect(evaluateRules(rules, files, fileSet, edges)[0].description).toBe('no UI→DB')
  })
})
