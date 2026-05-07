import { describe, it, expect } from 'vitest'
import { diffSets, countTensionDelta } from '../src/routes/diff.js'

describe('diffSets', () => {
  it('computes added/removed/common', () => {
    const r = diffSets(['a', 'b', 'c'], ['b', 'c', 'd', 'e'])
    expect(r.added.sort()).toEqual(['d', 'e'])
    expect(r.removed.sort()).toEqual(['a'])
    expect(r.commonCount).toBe(2)
  })

  it('handles empty inputs', () => {
    expect(diffSets([], [])).toEqual({ added: [], removed: [], commonCount: 0 })
    expect(diffSets(['a'], [])).toEqual({ added: [], removed: ['a'], commonCount: 0 })
    expect(diffSets([], ['a'])).toEqual({ added: ['a'], removed: [], commonCount: 0 })
  })

  it('treats duplicates as set membership', () => {
    const r = diffSets(['a', 'a', 'b'], ['a', 'c'])
    expect(r.added).toEqual(['c'])
    expect(r.removed).toEqual(['b'])
    expect(r.commonCount).toBe(1)
  })
})

describe('countTensionDelta', () => {
  it('counts net cycles added/removed', () => {
    const r = countTensionDelta(
      { cycles: [{ files: ['a', 'b'] }] },
      { cycles: [{ files: ['a', 'b'] }, { files: ['c', 'd'] }] },
    )
    expect(r.cyclesAdded).toBe(1)
    expect(r.cyclesRemoved).toBe(0)
  })

  it('counts net low-value barrels', () => {
    const r = countTensionDelta(
      {
        barrels: [
          { file: 'a', reExportCount: 1, consumerCount: 0, lowValue: true },
          { file: 'b', reExportCount: 2, consumerCount: 0, lowValue: true },
        ],
      },
      { barrels: [{ file: 'a', reExportCount: 1, consumerCount: 0, lowValue: true }] },
    )
    expect(r.barrelsLowAdded).toBe(0)
    expect(r.barrelsLowRemoved).toBe(1)
  })

  it('counts long fns (≥80 lines)', () => {
    const r = countTensionDelta(
      { longFunctions: [{ file: 'a', lines: 50 }] }, // < 80, ignored
      { longFunctions: [{ file: 'a', lines: 50 }, { file: 'b', lines: 100 }] },
    )
    expect(r.longFunctionsAdded).toBe(1)
    expect(r.longFunctionsRemoved).toBe(0)
  })

  it('clamps negative deltas to zero (added/removed are non-negative)', () => {
    const r = countTensionDelta({ cycles: [{ files: ['a'] }, { files: ['b'] }] }, { cycles: [{ files: ['a'] }] })
    expect(r.cyclesAdded).toBe(0)
    expect(r.cyclesRemoved).toBe(1)
  })
})
