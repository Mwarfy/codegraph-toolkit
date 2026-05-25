/**
 * Tests de `cli/commands/deps.ts` — fonctions pures extraites de
 * `runDepsCommand` (refactor complexité cyclo 27 / cognitive 59 → orchestrateur
 * + sous-fonctions de rendu). Couvre la structuration des données (comptage,
 * groupement) indépendamment du rendu console.
 */

import { describe, it, expect } from 'vitest'
import { countIssuesByKind, groupIssuesByManifest } from '../src/cli/commands/deps.js'
import type { PackageDepsIssue, PackageDepsIssueKind } from '../src/core/types.js'

function issue(
  kind: PackageDepsIssueKind,
  packageName: string,
  packageJson: string,
  importers: string[] = [],
): PackageDepsIssue {
  return { kind, packageName, packageJson, importers }
}

describe('countIssuesByKind', () => {
  it('compte les issues par kind avec zéro pour les kinds absents', () => {
    const issues = [
      issue('missing', 'a', 'p'),
      issue('missing', 'b', 'p'),
      issue('devOnly', 'c', 'p'),
      issue('declared-unused', 'd', 'p'),
    ]
    expect(countIssuesByKind(issues)).toEqual({
      'declared-unused': 1,
      'declared-runtime-asset': 0,
      missing: 2,
      devOnly: 1,
    })
  })

  it('retourne tous les compteurs à zéro pour une liste vide', () => {
    expect(countIssuesByKind([])).toEqual({
      'declared-unused': 0,
      'declared-runtime-asset': 0,
      missing: 0,
      devOnly: 0,
    })
  })
})

describe('groupIssuesByManifest', () => {
  it('groupe par packageJson en préservant l ordre d insertion et d apparition', () => {
    const a = issue('missing', 'x', 'pkg-a')
    const b = issue('devOnly', 'y', 'pkg-b')
    const c = issue('missing', 'z', 'pkg-a')

    const grouped = groupIssuesByManifest([a, b, c])

    expect([...grouped.keys()]).toEqual(['pkg-a', 'pkg-b'])
    expect(grouped.get('pkg-a')).toEqual([a, c])
    expect(grouped.get('pkg-b')).toEqual([b])
  })

  it('retourne une map vide pour une liste vide', () => {
    expect(groupIssuesByManifest([]).size).toBe(0)
  })
})
