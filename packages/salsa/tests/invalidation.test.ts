/**
 * Invalidation semantics — multi-level dep chains, no-op writes,
 * downstream skip when upstream value is unchanged.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { Database, input, derived } from '../src/index.js'

describe('salsa — invalidation', () => {
  let db: Database
  beforeEach(() => { db = new Database() })

  it('transitive: A → B → C, A changes, all recompute', () => {
    const a = input<string, number>(db, 'a')
    const b = derived<string, number>(db, 'b', (k) => a.get(k) + 1)
    const c = derived<string, number>(db, 'c', (k) => b.get(k) * 10)
    a.set('x', 1)
    expect(c.get('x')).toBe(20)                                // b=2, c=20
    a.set('x', 5)
    expect(c.get('x')).toBe(60)                                // b=6, c=60
    const stats = db.stats()
    expect(stats.misses.b).toBe(2)
    expect(stats.misses.c).toBe(2)
  })

  it('no-op write: same value SET → downstream not recomputed', () => {
    const a = input<string, number>(db, 'a')
    const b = derived<string, number>(db, 'b', (k) => a.get(k) * 2)
    a.set('x', 7)
    expect(b.get('x')).toBe(14)
    a.set('x', 7)                                              // same value
    expect(b.get('x')).toBe(14)
    const stats = db.stats()
    expect(stats.misses.b).toBe(1)                             // only 1 compute
  })

  it('"red/green" — derived value unchanged → grandchild not recomputed', () => {
    const a = input<string, number>(db, 'a')
    // b returns the SIGN of a (-1 / 0 / +1) — many a's collapse to same sign.
    const b = derived<string, number>(db, 'b', (k) => Math.sign(a.get(k)))
    const c = derived<string, number>(db, 'c', (k) => b.get(k) * 100)

    a.set('x', 5)
    expect(c.get('x')).toBe(100)                               // sign=1, c=100
    a.set('x', 10)                                             // a changed
    expect(c.get('x')).toBe(100)                               // sign still 1
    const stats = db.stats()
    expect(stats.misses.b).toBe(2)                             // b recomputed (a changed)
    expect(stats.misses.c).toBe(1)                             // c skipped! b's value didn't change
  })

  it('verifiedAt fast path: same revision query → no dep walk', () => {
    const a = input<string, number>(db, 'a')
    const b = derived<string, number>(db, 'b', (k) => a.get(k) + 1)
    a.set('x', 1)
    b.get('x')                                                 // miss
    b.get('x')                                                 // hit (verifiedAt)
    b.get('x')                                                 // hit
    const stats = db.stats()
    expect(stats.hits.b).toBe(2)
    expect(stats.misses.b).toBe(1)
  })

  it('multi-key derived independent', () => {
    const a = input<string, number>(db, 'a')
    const square = derived<string, number>(db, 'square', (k) => {
      const v = a.get(k)
      return v * v
    })
    a.set('x', 3)
    a.set('y', 4)
    expect(square.get('x')).toBe(9)
    expect(square.get('y')).toBe(16)
    a.set('x', 5)                                              // only x changed
    expect(square.get('x')).toBe(25)                           // recomputed
    expect(square.get('y')).toBe(16)                           // cached
    const stats = db.stats()
    expect(stats.misses.square).toBe(3)                        // x×2 + y×1
    expect(stats.hits.square).toBe(1)                          // y read again
  })

  it('aggregator (multi-dep): one of N upstreams changed → recompute', () => {
    const f = input<string, number>(db, 'f')
    f.set('a', 1); f.set('b', 2); f.set('c', 3)
    const sum = derived<string, number>(db, 'sum', (_label) =>
      f.get('a') + f.get('b') + f.get('c'),
    )
    expect(sum.get('all')).toBe(6)
    f.set('b', 20)
    expect(sum.get('all')).toBe(24)
    expect(db.stats().misses.sum).toBe(2)
  })

  it('aggregator: one of N upstreams set to same value → no recompute', () => {
    const f = input<string, number>(db, 'f')
    f.set('a', 1); f.set('b', 2); f.set('c', 3)
    const sum = derived<string, number>(db, 'sum', (_label) =>
      f.get('a') + f.get('b') + f.get('c'),
    )
    expect(sum.get('all')).toBe(6)
    f.set('b', 2)                                              // same value → no-op
    expect(sum.get('all')).toBe(6)
    expect(db.stats().misses.sum).toBe(1)                      // skipped
  })

  it('peek shows cell metadata after compute', () => {
    const a = input<string, number>(db, 'a')
    const b = derived<string, number>(db, 'b', (k) => a.get(k) * 2)
    a.set('x', 5)
    b.get('x')
    const cell = b.peek('x')!
    expect(cell.value).toBe(10)
    expect(cell.deps).toHaveLength(1)
    expect(cell.deps[0].queryId).toBe('a')
    expect(cell.computedAt).toBeGreaterThan(0)
    expect(cell.verifiedAt).toBe(cell.computedAt)
  })
})
