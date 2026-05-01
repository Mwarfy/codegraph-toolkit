/**
 * Aggregate tests (Tier 14 alt2) — count/sum/min/max post-strates.
 */

import { describe, it, expect } from 'vitest'
import { runFromString } from '../src/runner.js'

describe('aggregate — count', () => {
  it('counts rows per group key (single var)', () => {
    const { result } = runFromString({
      rules: `
        .decl Item(file: symbol, score: number)
        .input Item

        .count CountPerFile(file: symbol, n: number) by Item(F, _)
        .output CountPerFile
      `,
      facts: new Map([
        ['Item', [['a.ts', 10], ['a.ts', 20], ['a.ts', 30], ['b.ts', 5]]],
      ]),
    })
    expect(result.outputs.get('CountPerFile')).toEqual([
      ['a.ts', 3], ['b.ts', 1],
    ])
  })

  it('counts with multi-var grouping', () => {
    const { result } = runFromString({
      rules: `
        .decl Use(file: symbol, callee: symbol, line: number)
        .input Use

        .count UsesPerSite(file: symbol, callee: symbol, n: number)
          by Use(F, C, _)
        .output UsesPerSite
      `,
      facts: new Map([
        ['Use', [
          ['a.ts', 'fetch', 10], ['a.ts', 'fetch', 20], ['a.ts', 'eval', 5],
          ['b.ts', 'fetch', 1],
        ]],
      ]),
    })
    expect(result.outputs.get('UsesPerSite')).toEqual([
      ['a.ts', 'eval', 1],
      ['a.ts', 'fetch', 2],
      ['b.ts', 'fetch', 1],
    ])
  })
})

describe('aggregate — sum / min / max', () => {
  const facts = new Map([
    ['Item', [
      ['a.ts', 10], ['a.ts', 20], ['a.ts', 30],
      ['b.ts', 5], ['b.ts', 100],
      ['c.ts', 1],
    ] as Array<[string, number]>],
  ])

  it('sums numeric values per group', () => {
    const { result } = runFromString({
      rules: `
        .decl Item(file: symbol, score: number)
        .input Item

        .sum SumPerFile(file: symbol, total: number) by Item(F, V)
        .output SumPerFile
      `,
      facts,
    })
    expect(result.outputs.get('SumPerFile')).toEqual([
      ['a.ts', 60], ['b.ts', 105], ['c.ts', 1],
    ])
  })

  it('returns max of value column', () => {
    const { result } = runFromString({
      rules: `
        .decl Item(file: symbol, score: number)
        .input Item

        .max MaxPerFile(file: symbol, peak: number) by Item(F, V)
        .output MaxPerFile
      `,
      facts,
    })
    expect(result.outputs.get('MaxPerFile')).toEqual([
      ['a.ts', 30], ['b.ts', 100], ['c.ts', 1],
    ])
  })

  it('returns min of value column', () => {
    const { result } = runFromString({
      rules: `
        .decl Item(file: symbol, score: number)
        .input Item

        .min MinPerFile(file: symbol, valley: number) by Item(F, V)
        .output MinPerFile
      `,
      facts,
    })
    expect(result.outputs.get('MinPerFile')).toEqual([
      ['a.ts', 10], ['b.ts', 5], ['c.ts', 1],
    ])
  })
})

describe('aggregate — error cases', () => {
  it('rejects non-numeric last col in result decl', () => {
    expect(() => runFromString({
      rules: `
        .decl Item(file: symbol)
        .input Item

        .count BadCount(file: symbol, n: symbol) by Item(F)
        .output BadCount
      `,
      facts: new Map([['Item', [['a.ts']]]]),
    })).toThrow(/last column.*must be type 'number'/)
  })

  it('rejects sum/min/max without value variable', () => {
    expect(() => runFromString({
      rules: `
        .decl Item(file: symbol)
        .input Item

        .sum BadSum(n: number) by Item(_)
        .output BadSum
      `,
      facts: new Map([['Item', [['a.ts']]]]),
    })).toThrow(/needs at least one value variable/)
  })

  it('rejects arity mismatch between pattern vars and result decl', () => {
    expect(() => runFromString({
      rules: `
        .decl Item(file: symbol, score: number)
        .input Item

        .count BadCount(file: symbol, callee: symbol, n: number) by Item(F, _)
        .output BadCount
      `,
      facts: new Map([['Item', [['a.ts', 10]]]]),
    })).toThrow(/group var.*non-aggregate col/)
  })
})
