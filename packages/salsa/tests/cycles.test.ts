/**
 * Cycle detection — direct + transitive cycles must throw cleanly.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { Database, input, derived, SalsaError } from '../src/index.js'

describe('salsa — cycle detection', () => {
  let db: Database
  beforeEach(() => { db = new Database() })

  it('direct self-cycle throws', () => {
    const a = derived<string, number>(db, 'a', (k) => a.get(k) + 1)
    expect(() => a.get('x')).toThrow(SalsaError)
    expect(() => a.get('x')).toThrow(/cycle detected/)
  })

  it('two-step mutual cycle throws', () => {
    const i = input<string, number>(db, 'i')
    i.set('x', 1)
    const a = derived<string, number>(db, 'a', (k) => b.get(k) + i.get(k))
    const b = derived<string, number>(db, 'b', (k) => a.get(k) + 1)
    expect(() => a.get('x')).toThrow(/cycle detected/)
  })

  it('cycle on a different key path is allowed', () => {
    // Non-cycle: a('x') depends on b('y'), b('y') depends on input.
    // a('x') and b('x') would be independent — different keys.
    const i = input<string, number>(db, 'i')
    i.set('x', 1); i.set('y', 2)
    const b = derived<string, number>(db, 'b', (k) => i.get(k) * 10)
    const a = derived<string, number>(db, 'a', (k) => {
      if (k === 'x') return b.get('y') + i.get(k)             // a('x') deps on b('y'), not b('x')
      return i.get(k)
    })
    expect(a.get('x')).toBe(20 + 1)                            // 21
    expect(b.get('x')).toBe(10)
    expect(a.get('y')).toBe(2)
  })
})
