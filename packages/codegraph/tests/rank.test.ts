// ADR-005
/**
 * Tests pour `synopsis/rank.ts` — Personalized PageRank.
 *
 * Stratégie : graphes synthétiques minimaux où le ranking attendu est
 * dérivable à la main, puis vérification que rankFiles produit le bon
 * ordre + les bonnes reasons.
 */

import { describe, it, expect } from 'vitest'
import { rankFiles } from '../src/synopsis/rank.js'
import type { GraphSnapshot } from '../src/core/types.js'

function buildSnapshot(opts: {
  files: string[]
  imports?: Array<[string, string]>
  coChange?: Array<{ from: string; to: string; jaccard: number; count: number }>
}): GraphSnapshot {
  const nodes = opts.files.map((id) => ({
    id,
    label: id,
    type: 'file' as const,
    status: 'connected' as const,
    tags: [],
  }))
  const edges = (opts.imports ?? []).map(([from, to]) => ({
    id: `${from}→${to}`,
    from,
    to,
    type: 'import' as const,
  }))
  return {
    nodes,
    edges,
    coChangePairs: opts.coChange ?? [],
  } as unknown as GraphSnapshot
}

describe('rankFiles — Personalized PageRank', () => {
  it('focus file gets the highest score', () => {
    // 5 fichiers, A imports B et C. Focus = A.
    // A devrait être en tête (boost 100), puis B et C (1-hop, boost 50 chacun).
    const snap = buildSnapshot({
      files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'],
      imports: [
        ['a.ts', 'b.ts'],
        ['a.ts', 'c.ts'],
      ],
    })

    const ranked = rankFiles(snap, { focus: ['a.ts'] })

    expect(ranked[0].file).toBe('a.ts')
    expect(ranked[0].reasons).toContain('focus')
  })

  it('1-hop neighbors are tagged with their relation', () => {
    const snap = buildSnapshot({
      files: ['a.ts', 'b.ts', 'c.ts'],
      imports: [
        ['a.ts', 'b.ts'],
        ['c.ts', 'a.ts'],
      ],
    })

    const ranked = rankFiles(snap, { focus: ['a.ts'] })

    const b = ranked.find((r) => r.file === 'b.ts')!
    const c = ranked.find((r) => r.file === 'c.ts')!

    expect(b.reasons.some((r) => r.startsWith('imported by'))).toBe(true)
    expect(c.reasons.some((r) => r.startsWith('imports'))).toBe(true)
  })

  it('co-change partners get boost when within top-5 of focus', () => {
    const snap = buildSnapshot({
      files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
      imports: [],
      coChange: [
        { from: 'a.ts', to: 'b.ts', jaccard: 0.8, count: 10 },
        { from: 'a.ts', to: 'c.ts', jaccard: 0.5, count: 5 },
      ],
    })

    const ranked = rankFiles(snap, { focus: ['a.ts'] })

    const b = ranked.find((r) => r.file === 'b.ts')!
    const c = ranked.find((r) => r.file === 'c.ts')!
    const d = ranked.find((r) => r.file === 'd.ts')!

    expect(b.reasons.some((r) => r.startsWith('co-change'))).toBe(true)
    expect(c.reasons.some((r) => r.startsWith('co-change'))).toBe(true)
    expect(d.reasons).not.toContain(expect.stringContaining('co-change'))

    // b should rank higher than c (jaccard 0.8 vs 0.5)
    const bIdx = ranked.findIndex((r) => r.file === 'b.ts')
    const cIdx = ranked.findIndex((r) => r.file === 'c.ts')
    expect(bIdx).toBeLessThan(cIdx)
  })

  it('recently-modified files get a soft boost', () => {
    const snap = buildSnapshot({
      files: ['a.ts', 'b.ts', 'c.ts'],
      imports: [],
    })

    const ranked = rankFiles(snap, {
      focus: ['a.ts'],
      recentlyModified: ['b.ts'],
    })

    const b = ranked.find((r) => r.file === 'b.ts')!
    const c = ranked.find((r) => r.file === 'c.ts')!

    expect(b.reasons).toContain('recently modified')
    expect(c.reasons).not.toContain('recently modified')
    expect(b.score).toBeGreaterThan(c.score)
  })

  it('output is deterministic across runs', () => {
    const snap = buildSnapshot({
      files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'],
      imports: [
        ['a.ts', 'c.ts'],
        ['b.ts', 'c.ts'],
        ['c.ts', 'd.ts'],
        ['c.ts', 'e.ts'],
      ],
    })

    const r1 = rankFiles(snap, { focus: ['a.ts'] })
    const r2 = rankFiles(snap, { focus: ['a.ts'] })

    expect(r1.map((r) => r.file)).toEqual(r2.map((r) => r.file))
    for (let i = 0; i < r1.length; i++) {
      expect(r1[i].score).toBeCloseTo(r2[i].score, 10)
    }
  })

  it('all scores sum to ~1 (PageRank invariant)', () => {
    const snap = buildSnapshot({
      files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
      imports: [
        ['a.ts', 'b.ts'],
        ['b.ts', 'c.ts'],
        ['c.ts', 'd.ts'],
        ['d.ts', 'a.ts'],
      ],
    })

    const ranked = rankFiles(snap, { focus: ['a.ts'] })
    const total = ranked.reduce((s, r) => s + r.score, 0)

    expect(total).toBeCloseTo(1.0, 5)
  })

  it('isolated file unrelated to focus is correctly ranked low', () => {
    // Avec personalization focused (100% sur a.ts), un fichier sans aucune
    // connexion au focus reçoit 0 mass. C'est précisément le comportement
    // souhaité — l'agent ne devrait pas se voir proposer un fichier sans
    // rapport quand il travaille sur a.ts.
    const snap = buildSnapshot({
      files: ['a.ts', 'b.ts', 'isolated.ts'],
      imports: [['a.ts', 'b.ts']],
    })

    const ranked = rankFiles(snap, { focus: ['a.ts'] })
    const isolated = ranked.find((r) => r.file === 'isolated.ts')!
    const a = ranked.find((r) => r.file === 'a.ts')!
    const b = ranked.find((r) => r.file === 'b.ts')!

    expect(isolated.score).toBe(0)
    expect(a.score).toBeGreaterThan(isolated.score)
    expect(b.score).toBeGreaterThan(isolated.score)

    // En cas d'empty focus (uniform personalization), même fichier isolé
    // reçoit baseline = 1/n.
    const rankedNoFocus = rankFiles(snap, { focus: [] })
    const isolatedNoFocus = rankedNoFocus.find((r) => r.file === 'isolated.ts')!
    expect(isolatedNoFocus.score).toBeGreaterThan(0)
  })

  it('empty focus produces a neutral ranking (uniform personalization)', () => {
    const snap = buildSnapshot({
      files: ['a.ts', 'b.ts', 'c.ts'],
      imports: [
        ['a.ts', 'b.ts'],
        ['c.ts', 'b.ts'],
      ],
    })

    const ranked = rankFiles(snap, { focus: [] })

    // b.ts has 2 incoming imports, should be top
    expect(ranked[0].file).toBe('b.ts')
  })

  it('multiple focus files boost both', () => {
    const snap = buildSnapshot({
      files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
      imports: [
        ['a.ts', 'd.ts'],
        ['b.ts', 'd.ts'],
      ],
    })

    const ranked = rankFiles(snap, { focus: ['a.ts', 'b.ts'] })

    const a = ranked.find((r) => r.file === 'a.ts')!
    const b = ranked.find((r) => r.file === 'b.ts')!
    const c = ranked.find((r) => r.file === 'c.ts')!

    expect(a.reasons).toContain('focus')
    expect(b.reasons).toContain('focus')
    expect(a.score).toBeGreaterThan(c.score)
    expect(b.score).toBeGreaterThan(c.score)
  })

  it('no files in snapshot returns empty array', () => {
    const snap = buildSnapshot({ files: [] })
    const ranked = rankFiles(snap, { focus: ['nonexistent.ts'] })
    expect(ranked).toEqual([])
  })
})
