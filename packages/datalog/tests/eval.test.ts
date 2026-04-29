/**
 * Evaluator tests — joins, negation, stratification, proof recording,
 * and BYTE-determinism across reruns.
 */

import { describe, it, expect } from 'vitest'
import { runFromString } from '../src/runner.js'
import { sortTuples } from '../src/canonical.js'
import { DatalogError } from '../src/types.js'

describe('eval — basic semantics', () => {
  it('derives transitive-style joins (one-hop)', () => {
    const { result } = runFromString({
      rules: `
        .decl Edge(from: symbol, to: symbol)
        .decl Linked(from: symbol, to: symbol)
        .input Edge .output Linked
        Linked(X, Z) :- Edge(X, Y), Edge(Y, Z).
      `,
      facts: new Map([
        ['Edge', [['a', 'b'], ['b', 'c'], ['c', 'd']]],
      ]),
    })
    const linked = result.outputs.get('Linked')!
    expect(linked).toEqual([
      ['a', 'c'],
      ['b', 'd'],
    ])
  })

  it('handles negation correctly', () => {
    const { result } = runFromString({
      rules: `
        .decl HasA(x: symbol)
        .decl HasB(x: symbol)
        .decl OnlyA(x: symbol)
        .input HasA .input HasB .output OnlyA
        OnlyA(X) :- HasA(X), !HasB(X).
      `,
      facts: new Map([
        ['HasA', [['x'], ['y'], ['z']]],
        ['HasB', [['y']]],
      ]),
    })
    expect(result.outputs.get('OnlyA')).toEqual([['x'], ['z']])
  })

  it('returns empty when no fact matches', () => {
    const { result } = runFromString({
      rules: `
        .decl A(x: symbol) .decl B(x: symbol)
        .input A .output B
        B(X) :- A(X).
      `,
      facts: new Map(),
    })
    expect(result.outputs.get('B')).toEqual([])
  })

  it('multi-rule stratum with shared head accumulates results', () => {
    const { result } = runFromString({
      rules: `
        .decl A(x: symbol) .decl B(x: symbol) .decl Out(x: symbol)
        .input A .input B .output Out
        Out(X) :- A(X).
        Out(X) :- B(X).
      `,
      facts: new Map([
        ['A', [['1']]],
        ['B', [['2'], ['1']]],
      ]),
    })
    // Dedup: '1' from both rules, '2' from B.
    expect(result.outputs.get('Out')).toEqual([['1'], ['2']])
  })

  it('matches with constants in body atoms', () => {
    const { result } = runFromString({
      rules: `
        .decl Score(name: symbol, n: number) .decl Top(name: symbol)
        .input Score .output Top
        Top(N) :- Score(N, 100).
      `,
      facts: new Map([
        ['Score', [['alice', 100], ['bob', 50], ['carol', 100]]],
      ]),
    })
    expect(result.outputs.get('Top')).toEqual([['alice'], ['carol']])
  })

  it('wildcards do not constrain or bind', () => {
    const { result } = runFromString({
      rules: `
        .decl Edge(from: symbol, to: symbol) .decl HasOutgoing(x: symbol)
        .input Edge .output HasOutgoing
        HasOutgoing(X) :- Edge(X, _).
      `,
      facts: new Map([
        ['Edge', [['a', 'b'], ['c', 'd']]],
      ]),
    })
    expect(result.outputs.get('HasOutgoing')).toEqual([['a'], ['c']])
  })
})

describe('eval — stratification', () => {
  it('rejects direct recursion by default', () => {
    let caught: unknown
    try {
      runFromString({
        rules: `
          .decl Edge(x: symbol, y: symbol) .decl Reach(x: symbol, y: symbol)
          .input Edge .output Reach
          Reach(X, Y) :- Edge(X, Y).
          Reach(X, Z) :- Reach(X, Y), Edge(Y, Z).
        `,
      })
    } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(DatalogError)
    expect((caught as DatalogError).code).toBe('stratify.recursionDisallowed')
  })

  it('rejects negation through recursion (always)', () => {
    let caught: unknown
    try {
      runFromString({
        rules: `
          .decl Source(x: symbol)
          .decl A(x: symbol)
          .input Source .output A
          A(X) :- Source(X), !A(X).
        `,
      })
    } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(DatalogError)
    expect((caught as DatalogError).code).toBe('stratify.negationInRecursion')
  })

  it('orders strata so dependencies are evaluated first', () => {
    const { result } = runFromString({
      rules: `
        .decl A(x: symbol) .decl B(x: symbol) .decl C(x: symbol)
        .input A .output B .output C
        B(X) :- A(X).
        C(X) :- B(X).
      `,
      facts: new Map([['A', [['1'], ['2']]]]),
    })
    expect(result.outputs.get('C')).toEqual([['1'], ['2']])
  })
})

describe('eval — proof recording', () => {
  it('records the rule + body tuples that derived a violation', () => {
    const { result } = runFromString({
      rules: `
        .decl Site(file: symbol, line: number)
        .decl OnAllowList(file: symbol)
        .decl Violation(file: symbol, line: number)
        .input Site .input OnAllowList .output Violation
        Violation(F, L) :- Site(F, L), !OnAllowList(F).
      `,
      facts: new Map([
        ['Site', [['src/a.ts', 10], ['src/b.ts', 20]]],
        ['OnAllowList', [['src/b.ts']]],
      ]),
      evalOptions: { recordProofsFor: ['Violation'] },
    })
    expect(result.outputs.get('Violation')).toEqual([['src/a.ts', 10]])
    expect(result.proofs).toBeDefined()
    const proofs = result.proofs!.get('Violation')!
    expect(proofs.size).toBe(1)
    const node = [...proofs.values()][0]
    expect(node.rel).toBe('Violation')
    expect(node.tuple).toEqual(['src/a.ts', 10])
    expect(node.via.kind).toBe('rule')
    if (node.via.kind === 'rule') {
      expect(node.via.bodyTuples.length).toBe(1)        // 1 positive atom
      expect(node.via.bodyTuples[0].rel).toBe('Site')
    }
  })
})

describe('eval — DETERMINISM', () => {
  it('produces byte-identical output across 10 reruns', () => {
    const ruleSrc = `
      .decl File(file: symbol) .decl Imports(from: symbol, to: symbol)
      .decl HubLike(file: symbol) .decl Violation(file: symbol)
      .decl InAllowList(file: symbol)
      .input File .input Imports .input InAllowList .output Violation
      HubLike(F) :- Imports(_, F), File(F).
      Violation(F) :- HubLike(F), !InAllowList(F).
    `
    // Pseudo-random-ish facts ; tests must not depend on insertion order.
    const facts = new Map([
      ['File', [['a.ts'], ['b.ts'], ['c.ts'], ['d.ts'], ['e.ts']]],
      ['Imports', [
        ['a.ts', 'b.ts'], ['c.ts', 'b.ts'], ['d.ts', 'b.ts'],
        ['a.ts', 'c.ts'], ['e.ts', 'c.ts'],
      ]],
      ['InAllowList', [['c.ts']]],
    ])

    const sigs: string[] = []
    for (let i = 0; i < 10; i++) {
      const { result } = runFromString({ rules: ruleSrc, facts })
      const tuples = result.outputs.get('Violation')!
      sigs.push(JSON.stringify(tuples))
    }
    expect(new Set(sigs).size).toBe(1)
    // And the content makes sense: only 'b.ts' is hub-like (not on allowlist).
    expect(JSON.parse(sigs[0])).toEqual([['b.ts']])
  })

  it('output relations are sorted lex (number < string)', () => {
    const { result } = runFromString({
      rules: `
        .decl T(a: symbol, n: number) .decl Out(a: symbol, n: number)
        .input T .output Out
        Out(A, N) :- T(A, N).
      `,
      facts: new Map([
        ['T', [['z', 1], ['a', 5], ['a', 1], ['m', 3]]],
      ]),
    })
    const out = result.outputs.get('Out')!
    expect(out).toEqual([
      ['a', 1], ['a', 5], ['m', 3], ['z', 1],
    ])
    // sortTuples is idempotent.
    expect(sortTuples(out)).toEqual(out)
  })
})
