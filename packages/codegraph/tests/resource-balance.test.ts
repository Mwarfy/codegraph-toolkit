/**
 * Tests pour resource-balance (Phase 4 Tier 6).
 */

import { describe, it, expect } from 'vitest'
import { Project } from 'ts-morph'
import { extractResourceBalanceFileBundle } from '../src/extractors/resource-balance.js'

function fileFromText(text: string, name = 'src/test.ts') {
  const project = new Project({ useInMemoryFileSystem: true })
  const sf = project.createSourceFile(name, text)
  return { sf, name }
}

describe('resource-balance', () => {
  it('skip pure-acquire (pattern start/stop split)', () => {
    const { sf, name } = fileFromText(`
      export function start() {
        const timer = setInterval(() => {}, 1000)
      }
    `)
    const { imbalances } = extractResourceBalanceFileBundle(sf, name)
    expect(imbalances).toEqual([])
  })

  it('skip pure-release (pattern start/stop split)', () => {
    const { sf, name } = fileFromText(`
      export function stop(timer: any) {
        clearInterval(timer)
      }
    `)
    const { imbalances } = extractResourceBalanceFileBundle(sf, name)
    expect(imbalances).toEqual([])
  })

  it('skip si setInterval + clearInterval matchent', () => {
    const { sf, name } = fileFromText(`
      export function start() {
        const timer = setInterval(() => {}, 1000)
        clearInterval(timer)
      }
    `)
    const { imbalances } = extractResourceBalanceFileBundle(sf, name)
    expect(imbalances).toEqual([])
  })

  it('flag intra-function imbalance (acquire 2x, release 1x)', () => {
    const { sf, name } = fileFromText(`
      export function f() {
        const a = setInterval(() => {}, 1)
        const b = setInterval(() => {}, 2)
        clearInterval(a)
      }
    `)
    const { imbalances } = extractResourceBalanceFileBundle(sf, name)
    expect(imbalances).toHaveLength(1)
    expect(imbalances[0].acquireCount).toBe(2)
    expect(imbalances[0].releaseCount).toBe(1)
  })

  it('flag intra-function imbalance lock/unlock', () => {
    const { sf, name } = fileFromText(`
      export function critical() {
        mutex.lock()
        mutex.lock()
        doStuff()
        mutex.unlock()
      }
    `)
    const { imbalances } = extractResourceBalanceFileBundle(sf, name)
    expect(imbalances).toHaveLength(1)
    expect(imbalances[0].pair).toBe('lock/unlock')
  })

  it('skip avec marker resource-balance-ok', () => {
    const { sf, name } = fileFromText(`
      // resource-balance-ok: timer geree par worker pool, cleanup hors scope
      export function startTimer() {
        setInterval(() => {}, 1000)
      }
    `)
    const { imbalances } = extractResourceBalanceFileBundle(sf, name)
    expect(imbalances).toEqual([])
  })

  it('skip les fichiers de test', () => {
    const { sf, name } = fileFromText(
      `export function f() { setInterval(() => {}, 1000) }`,
      'tests/foo.test.ts',
    )
    const { imbalances } = extractResourceBalanceFileBundle(sf, name)
    expect(imbalances).toEqual([])
  })

  it('détecte sur class methods (intra-function imbalance)', () => {
    const { sf, name } = fileFromText(`
      export class Foo {
        bind() {
          window.addEventListener('a', h)
          window.addEventListener('b', h)
          window.removeEventListener('a', h)
        }
      }
    `)
    const { imbalances } = extractResourceBalanceFileBundle(sf, name)
    expect(imbalances).toHaveLength(1)
    expect(imbalances[0].containingSymbol).toBe('Foo.bind')
  })

  it('skip un addEventListener + removeEventListener equilibrés', () => {
    const { sf, name } = fileFromText(`
      export function bind() {
        window.addEventListener('click', handler)
        window.removeEventListener('click', handler)
      }
    `)
    const { imbalances } = extractResourceBalanceFileBundle(sf, name)
    expect(imbalances).toEqual([])
  })
})
