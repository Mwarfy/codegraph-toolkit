/**
 * Constraints (Tier 15) — numeric comparison ops `>`, `<`, `>=`, `<=`, `!=`
 * in rule body. Filtered post-join, before negative atoms.
 */

import { describe, it, expect } from 'vitest'
import { runFromString } from '../src/runner.js'
import { parse } from '../src/parser.js'
import { DatalogError } from '../src/types.js'

describe('constraint — gt / lt / gte / lte', () => {
  const facts = new Map([
    ['Score', [
      ['alice', 100], ['bob', 50], ['carol', 75], ['dave', 30],
    ] as Array<[string, number]>],
  ])

  it('filters via > threshold', () => {
    const { result } = runFromString({
      rules: `
        .decl Score(name: symbol, n: number)
        .decl HighScorer(name: symbol)
        .input Score
        .output HighScorer

        HighScorer(N) :- Score(N, V), V > 70.
      `,
      facts,
    })
    expect(result.outputs.get('HighScorer')).toEqual([['alice'], ['carol']])
  })

  it('filters via < threshold', () => {
    const { result } = runFromString({
      rules: `
        .decl Score(name: symbol, n: number)
        .decl LowScorer(name: symbol)
        .input Score
        .output LowScorer

        LowScorer(N) :- Score(N, V), V < 70.
      `,
      facts,
    })
    expect(result.outputs.get('LowScorer')).toEqual([['bob'], ['dave']])
  })

  it('handles >= and <= (boundary inclusive)', () => {
    const { result } = runFromString({
      rules: `
        .decl Score(name: symbol, n: number)
        .decl AtLeast75(name: symbol)
        .decl AtMost50(name: symbol)
        .input Score
        .output AtLeast75
        .output AtMost50

        AtLeast75(N) :- Score(N, V), V >= 75.
        AtMost50(N)  :- Score(N, V), V <= 50.
      `,
      facts,
    })
    expect(result.outputs.get('AtLeast75')).toEqual([['alice'], ['carol']])
    expect(result.outputs.get('AtMost50')).toEqual([['bob'], ['dave']])
  })
})

describe('constraint — != (any type)', () => {
  it('filters by inequality on number', () => {
    const { result } = runFromString({
      rules: `
        .decl Item(file: symbol, n: number)
        .decl NonZero(file: symbol)
        .input Item
        .output NonZero

        NonZero(F) :- Item(F, V), V != 0.
      `,
      facts: new Map([
        ['Item', [['a.ts', 0], ['b.ts', 5], ['c.ts', 0], ['d.ts', 1]]],
      ]),
    })
    expect(result.outputs.get('NonZero')).toEqual([['b.ts'], ['d.ts']])
  })

  it('filters by inequality on string', () => {
    const { result } = runFromString({
      rules: `
        .decl Tag(file: symbol, label: symbol)
        .decl NotMain(file: symbol)
        .input Tag
        .output NotMain

        NotMain(F) :- Tag(F, L), L != "main".
      `,
      facts: new Map([
        ['Tag', [['a.ts', 'main'], ['b.ts', 'aux'], ['c.ts', 'main'], ['d.ts', 'test']]],
      ]),
    })
    expect(result.outputs.get('NotMain')).toEqual([['b.ts'], ['d.ts']])
  })
})

describe('constraint — interplay with body atoms', () => {
  it('combines positive atoms + constraint + negation', () => {
    const { result } = runFromString({
      rules: `
        .decl Score(name: symbol, n: number)
        .decl Skip(name: symbol)
        .decl Winner(name: symbol)
        .input Score
        .input Skip
        .output Winner

        Winner(N) :- Score(N, V), V > 60, !Skip(N).
      `,
      facts: new Map<string, Array<readonly [string, number] | readonly [string]>>([
        ['Score', [['alice', 90], ['bob', 80], ['carol', 50], ['dave', 75]]],
        ['Skip', [['bob']]],
      ]),
    })
    expect(result.outputs.get('Winner')).toEqual([['alice'], ['dave']])
  })

  it('compares two bound vars', () => {
    const { result } = runFromString({
      rules: `
        .decl Limit(file: symbol, n: number)
        .decl Usage(file: symbol, n: number)
        .decl OverLimit(file: symbol)
        .input Limit
        .input Usage
        .output OverLimit

        OverLimit(F) :- Limit(F, L), Usage(F, U), U > L.
      `,
      facts: new Map([
        ['Limit', [['a.ts', 100], ['b.ts', 50], ['c.ts', 200]]],
        ['Usage', [['a.ts', 120], ['b.ts', 30], ['c.ts', 250]]],
      ]),
    })
    expect(result.outputs.get('OverLimit')).toEqual([['a.ts'], ['c.ts']])
  })
})

describe('constraint — chains with aggregates', () => {
  it('counts then thresholds (typical Tier 15 god-X pattern)', () => {
    const { result } = runFromString({
      rules: `
        .decl Use(file: symbol, line: number)
        .decl Hub(file: symbol)
        .input Use
        .output Hub

        .count UseCount(file: symbol, n: number) by Use(F, _)
        .output UseCount

        Hub(F) :- UseCount(F, N), N > 2.
      `,
      facts: new Map([
        ['Use', [
          ['a.ts', 1], ['a.ts', 2], ['a.ts', 3], ['a.ts', 4],
          ['b.ts', 1], ['b.ts', 2],
          ['c.ts', 1], ['c.ts', 2], ['c.ts', 3],
        ]],
      ]),
    })
    expect(result.outputs.get('Hub')).toEqual([['a.ts'], ['c.ts']])
  })
})

describe('constraint — parser errors', () => {
  it('rejects unbound variable in constraint', () => {
    expect(() => parse(`
      .decl A(x: symbol)
      .decl B(x: symbol)
      B(X) :- A(X), Y > 5.
    `)).toThrow(DatalogError)
  })

  it('rejects wildcard in constraint', () => {
    expect(() => parse(`
      .decl A(x: symbol, n: number)
      .decl B(x: symbol)
      B(X) :- A(X, _), _ > 5.
    `)).toThrow(DatalogError)
  })
})

describe('constraint — eval errors', () => {
  it('rejects ordering op on non-numeric', () => {
    expect(() => runFromString({
      rules: `
        .decl Tag(file: symbol, label: symbol)
        .decl Out(file: symbol)
        .input Tag
        .output Out

        Out(F) :- Tag(F, L), L > "abc".
      `,
      facts: new Map([['Tag', [['a.ts', 'main']]]]),
    })).toThrow(DatalogError)
  })
})
