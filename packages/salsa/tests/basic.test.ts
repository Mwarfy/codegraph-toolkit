/**
 * Basic semantics — input, derived, get, set, hit/miss counts.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { Database, input, derived, SalsaError } from '../src/index.js'

describe('salsa — basic semantics', () => {
  let db: Database
  beforeEach(() => { db = new Database() })

  it('input.set + input.get returns the stored value', () => {
    const x = input<string, number>(db, 'x')
    x.set('a', 42)
    expect(x.get('a')).toBe(42)
  })

  it('input.get throws if key was never set', () => {
    const x = input<string, number>(db, 'x')
    expect(() => x.get('missing')).toThrow(SalsaError)
    expect(() => x.get('missing')).toThrow(/no value for key/)
  })

  it('input.has reports whether a key is set', () => {
    const x = input<string, number>(db, 'x')
    expect(x.has('a')).toBe(false)
    x.set('a', 1)
    expect(x.has('a')).toBe(true)
  })

  it('derived computes from inputs and caches', () => {
    const x = input<string, number>(db, 'x')
    const double = derived<string, number>(db, 'double', (k) => x.get(k) * 2)
    x.set('a', 21)
    expect(double.get('a')).toBe(42)
    expect(double.get('a')).toBe(42)                          // hit
    const stats = db.stats()
    expect(stats.hits.double).toBe(1)
    expect(stats.misses.double).toBe(1)
  })

  it('derived recomputes when an input changes', () => {
    const x = input<string, number>(db, 'x')
    const double = derived<string, number>(db, 'double', (k) => x.get(k) * 2)
    x.set('a', 10)
    expect(double.get('a')).toBe(20)
    x.set('a', 11)
    expect(double.get('a')).toBe(22)                          // recomputed
    const stats = db.stats()
    expect(stats.misses.double).toBe(2)                       // 2 computes
  })

  it('derived skips recompute when other inputs change but its deps did not', () => {
    const x = input<string, number>(db, 'x')
    const y = input<string, number>(db, 'y')
    const usesX = derived<string, number>(db, 'usesX', (k) => x.get(k) * 2)
    x.set('a', 1)
    y.set('a', 99)
    expect(usesX.get('a')).toBe(2)                            // miss
    y.set('a', 100)                                           // not a dep of usesX
    expect(usesX.get('a')).toBe(2)                            // hit (verifiedAt bumped)
    const stats = db.stats()
    expect(stats.misses.usesX).toBe(1)                        // only 1 compute
  })

  it('rejects duplicate query ids', () => {
    input<string, number>(db, 'x')
    expect(() => input<string, number>(db, 'x')).toThrow(/already registered/)
    expect(() => derived<string, number>(db, 'x', () => 0)).toThrow(/already registered/)
  })

  it('rejects setting an input from inside a derived query', () => {
    const x = input<string, number>(db, 'x')
    const y = input<string, number>(db, 'y')
    const bad = derived<string, number>(db, 'bad', (k) => {
      y.set(k, 999)                                           // forbidden
      return x.get(k)
    })
    x.set('a', 1)
    expect(() => bad.get('a')).toThrow(/cannot \.set input/)
  })

  it('peek returns the cached cell or undefined', () => {
    const x = input<string, number>(db, 'x')
    const square = derived<string, number>(db, 'square', (k) => {
      const v = x.get(k)
      return v * v
    })
    x.set('a', 7)
    expect(square.peek('a')).toBeUndefined()
    expect(square.get('a')).toBe(49)
    const cell = square.peek('a')
    expect(cell).toBeDefined()
    expect(cell!.value).toBe(49)
    expect(cell!.deps.length).toBe(1)
    expect(cell!.deps[0].queryId).toBe('x')
  })

  it('supports tuple keys', () => {
    type K = readonly [string, number]
    const x = input<K, string>(db, 'x')
    x.set(['a', 1] as const, 'hello')
    x.set(['a', 2] as const, 'world')
    expect(x.get(['a', 1] as const)).toBe('hello')
    expect(x.get(['a', 2] as const)).toBe('world')
  })

  it('supports number keys', () => {
    const x = input<number, string>(db, 'x')
    x.set(42, 'forty-two')
    expect(x.get(42)).toBe('forty-two')
    expect(() => x.get(NaN)).toThrow(/cannot be NaN/)
  })
})
