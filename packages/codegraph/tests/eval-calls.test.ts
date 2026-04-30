/**
 * Tests pour eval-calls extractor (Phase 4 Tier 1).
 */

import { describe, it, expect } from 'vitest'
import { Project } from 'ts-morph'
import { extractEvalCallsFileBundle } from '../src/extractors/eval-calls.js'

function fileFromText(text: string, name = 'src/test.ts') {
  const project = new Project({ useInMemoryFileSystem: true })
  const sf = project.createSourceFile(name, text)
  return { project, sf, name }
}

describe('eval-calls', () => {
  it('détecte un eval direct', () => {
    const { sf, name } = fileFromText(`
      export function run(code: string) {
        return eval(code)
      }
    `)
    const { calls } = extractEvalCallsFileBundle(sf, name)
    expect(calls).toHaveLength(1)
    expect(calls[0].kind).toBe('eval')
    expect(calls[0].containingSymbol).toBe('run')
  })

  it('détecte new Function constructor', () => {
    const { sf, name } = fileFromText(`
      export function makeFn(body: string) {
        return new Function(body)
      }
    `)
    const { calls } = extractEvalCallsFileBundle(sf, name)
    expect(calls).toHaveLength(1)
    expect(calls[0].kind).toBe('function-constructor')
    expect(calls[0].containingSymbol).toBe('makeFn')
  })

  it('détecte plusieurs sites dans un fichier', () => {
    const { sf, name } = fileFromText(`
      export function a() { eval('1') }
      export function b() { return new Function('return 2') }
      export const c = () => eval('3')
    `)
    const { calls } = extractEvalCallsFileBundle(sf, name)
    expect(calls).toHaveLength(3)
    expect(calls.map((c) => c.kind).sort()).toEqual([
      'eval', 'eval', 'function-constructor',
    ])
  })

  it('ne flag PAS un identifier qui rappelle eval mais nest pas un call eval', () => {
    const { sf, name } = fileFromText(`
      const eval2 = (s: string) => s
      export function run(s: string) {
        // utilisation d'une variable nommée eval2 (pas global eval)
        return eval2(s)
      }
    `)
    const { calls } = extractEvalCallsFileBundle(sf, name)
    expect(calls).toEqual([])
  })

  it('ne flag PAS new Function avec accès dotted (foo.Function)', () => {
    const { sf, name } = fileFromText(`
      const ns = { Function: class { constructor(public x: string) {} } }
      export function run() {
        return new ns.Function('hi')
      }
    `)
    const { calls } = extractEvalCallsFileBundle(sf, name)
    expect(calls).toEqual([])
  })

  it('capture le containingSymbol pour méthode de classe', () => {
    const { sf, name } = fileFromText(`
      export class Runner {
        execute(code: string) {
          return eval(code)
        }
      }
    `)
    const { calls } = extractEvalCallsFileBundle(sf, name)
    expect(calls).toHaveLength(1)
    expect(calls[0].containingSymbol).toBe('Runner.execute')
  })

  it('capture le containingSymbol pour arrow assigné à const', () => {
    const { sf, name } = fileFromText(`
      export const runner = (code: string) => eval(code)
    `)
    const { calls } = extractEvalCallsFileBundle(sf, name)
    expect(calls).toHaveLength(1)
    expect(calls[0].containingSymbol).toBe('runner')
  })
})
