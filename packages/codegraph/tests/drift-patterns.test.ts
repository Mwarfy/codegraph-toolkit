/**
 * Tests pour drift-patterns extractor (Phase 4 axe 4).
 *
 * 3 patterns V1 :
 *   - excessive-optional-params (>5 params optionnels)
 *   - wrapper-superfluous (forward 1:1)
 *   - todo-no-owner (TODO sans @user ni #issue)
 *
 * + convention exempt `// drift-ok`.
 */

import { describe, it, expect } from 'vitest'
import { Project } from 'ts-morph'
import {
  extractDriftPatternsFileBundle,
  todoToDriftSignal,
} from '../src/extractors/drift-patterns.js'
import type { TodoMarker } from '../src/extractors/todos.js'

function fileFromText(text: string, name = 'src/test.ts') {
  const project = new Project({ useInMemoryFileSystem: true })
  const sf = project.createSourceFile(name, text)
  return { project, sf, name }
}

describe('drift-patterns — excessive-optional-params', () => {
  it('flag une fonction avec > 5 params optionnels', () => {
    const { sf, name } = fileFromText(`
      export function build(
        a?: string, b?: string, c?: string,
        d?: string, e?: string, f?: string,
      ) { return a }
    `)
    const { signals } = extractDriftPatternsFileBundle(sf, name)
    const opt = signals.find((s) => s.kind === 'excessive-optional-params')
    expect(opt).toBeDefined()
    expect(opt!.message).toContain('build a 6 params optionnels')
    expect(opt!.severity).toBe(2)
    expect(opt!.details!.optionalCount).toBe(6)
  })

  it('ne flag PAS sous le seuil', () => {
    const { sf, name } = fileFromText(`
      export function build(a?: string, b?: string) { return a }
    `)
    const { signals } = extractDriftPatternsFileBundle(sf, name)
    expect(signals.filter((s) => s.kind === 'excessive-optional-params')).toEqual([])
  })

  it('seuil custom override le default', () => {
    const { sf, name } = fileFromText(`
      export function build(a?: string, b?: string, c?: string) { return a }
    `)
    const { signals } = extractDriftPatternsFileBundle(sf, name, { optionalParamsThreshold: 2 })
    expect(signals.find((s) => s.kind === 'excessive-optional-params')).toBeDefined()
  })

  it('ne compte PAS les params required', () => {
    const { sf, name } = fileFromText(`
      export function build(
        a: string, b: string, c: string, d: string,
        e: string, f: string, g?: string,
      ) { return a }
    `)
    const { signals } = extractDriftPatternsFileBundle(sf, name)
    expect(signals.filter((s) => s.kind === 'excessive-optional-params')).toEqual([])
  })

  it('détecte sur class methods', () => {
    const { sf, name } = fileFromText(`
      export class Foo {
        bar(a?: string, b?: string, c?: string, d?: string, e?: string, f?: string) { return a }
      }
    `)
    const { signals } = extractDriftPatternsFileBundle(sf, name)
    const opt = signals.find((s) => s.kind === 'excessive-optional-params')
    expect(opt).toBeDefined()
    expect(opt!.details!.name).toBe('Foo.bar')
  })

  it('détecte sur arrow assigné à const', () => {
    const { sf, name } = fileFromText(`
      export const make = (a?: string, b?: string, c?: string, d?: string, e?: string, f?: string) => a
    `)
    const { signals } = extractDriftPatternsFileBundle(sf, name)
    const opt = signals.find((s) => s.kind === 'excessive-optional-params')
    expect(opt).toBeDefined()
    expect(opt!.details!.name).toBe('make')
  })
})

describe('drift-patterns — wrapper-superfluous', () => {
  it('flag un wrapper qui forward 1:1 (block body)', () => {
    const { sf, name } = fileFromText(`
      export function inner(a: string, b: number) { return a + b }
      export function outer(a: string, b: number) {
        return inner(a, b)
      }
    `)
    const { signals } = extractDriftPatternsFileBundle(sf, name)
    const w = signals.find((s) => s.kind === 'wrapper-superfluous')
    expect(w).toBeDefined()
    expect(w!.details!.name).toBe('outer')
    expect(w!.details!.callee).toBe('inner')
  })

  it('flag un wrapper arrow concise body', () => {
    const { sf, name } = fileFromText(`
      const inner = (x: number) => x
      export const outer = (x: number) => inner(x)
    `)
    const { signals } = extractDriftPatternsFileBundle(sf, name)
    expect(signals.find((s) => s.kind === 'wrapper-superfluous' && s.details!.name === 'outer')).toBeDefined()
  })

  it('ne flag PAS si la fonction transforme (args différents)', () => {
    const { sf, name } = fileFromText(`
      function inner(x: number) { return x }
      export function outer(x: number) {
        return inner(x + 1)
      }
    `)
    const { signals } = extractDriftPatternsFileBundle(sf, name)
    expect(signals.filter((s) => s.kind === 'wrapper-superfluous')).toEqual([])
  })

  it('ne flag PAS si la fonction a plusieurs statements', () => {
    const { sf, name } = fileFromText(`
      function inner(x: number) { return x }
      export function outer(x: number) {
        const y = x
        return inner(y)
      }
    `)
    const { signals } = extractDriftPatternsFileBundle(sf, name)
    expect(signals.filter((s) => s.kind === 'wrapper-superfluous')).toEqual([])
  })

  it('ne flag PAS si arity différente', () => {
    const { sf, name } = fileFromText(`
      function inner(x: number, y: number) { return x + y }
      export function outer(x: number) {
        return inner(x, 0)
      }
    `)
    const { signals } = extractDriftPatternsFileBundle(sf, name)
    expect(signals.filter((s) => s.kind === 'wrapper-superfluous')).toEqual([])
  })
})

describe('drift-patterns — convention drift-ok exempt', () => {
  it('skip le signal si la ligne précédente contient // drift-ok', () => {
    const { sf, name } = fileFromText(`
      // drift-ok: wrap intentionnel pour futur logging
      export function outer(a: string) {
        return inner(a)
      }
      function inner(a: string) { return a }
    `)
    const { signals } = extractDriftPatternsFileBundle(sf, name)
    expect(signals.filter((s) => s.kind === 'wrapper-superfluous')).toEqual([])
  })

  it('drift-ok exempt aussi pour excessive-optional-params', () => {
    const { sf, name } = fileFromText(`
      // drift-ok: API publique stable, params opt requis pour back-compat
      export function build(a?: string, b?: string, c?: string, d?: string, e?: string, f?: string) { return a }
    `)
    const { signals } = extractDriftPatternsFileBundle(sf, name)
    expect(signals.filter((s) => s.kind === 'excessive-optional-params')).toEqual([])
  })
})

describe('drift-patterns — deep-nesting (Tier 2)', () => {
  it('flag une fonction avec nesting profondeur > 5', () => {
    const { sf, name } = fileFromText(`
      export function deep() {
        if (true) {
          for (let i = 0; i < 10; i++) {
            while (i > 0) {
              if (i % 2 === 0) {
                try {
                  if (i > 5) {
                    return i
                  }
                } catch {}
              }
            }
          }
        }
      }
    `)
    const { signals } = extractDriftPatternsFileBundle(sf, name)
    const dn = signals.find((s) => s.kind === 'deep-nesting')
    expect(dn).toBeDefined()
    expect((dn!.details!.maxDepth as number)).toBeGreaterThan(5)
  })

  it('ne flag PAS sous le seuil', () => {
    const { sf, name } = fileFromText(`
      export function shallow(x: number) {
        if (x > 0) {
          return x
        }
        return 0
      }
    `)
    const { signals } = extractDriftPatternsFileBundle(sf, name)
    expect(signals.filter((s) => s.kind === 'deep-nesting')).toEqual([])
  })

  it('seuil custom', () => {
    const { sf, name } = fileFromText(`
      export function depth3(x: number) {
        if (x > 0) {
          if (x > 1) {
            if (x > 2) return x
          }
        }
      }
    `)
    const { signals } = extractDriftPatternsFileBundle(sf, name, { maxNestingDepth: 2 })
    expect(signals.find((s) => s.kind === 'deep-nesting')).toBeDefined()
  })
})

describe('drift-patterns — empty-catch (Tier 2)', () => {
  it('flag try/catch avec body vide sans commentaire', () => {
    const { sf, name } = fileFromText(`
      export function f() {
        try {
          doSomething()
        } catch (e) {}
      }
    `)
    const { signals } = extractDriftPatternsFileBundle(sf, name)
    expect(signals.find((s) => s.kind === 'empty-catch-no-comment')).toBeDefined()
  })

  it('skip si le catch a un commentaire', () => {
    const { sf, name } = fileFromText(`
      export function f() {
        try {
          doSomething()
        } catch {
          // intentional : best-effort cleanup
        }
      }
    `)
    const { signals } = extractDriftPatternsFileBundle(sf, name)
    expect(signals.filter((s) => s.kind === 'empty-catch-no-comment')).toEqual([])
  })

  it('skip si le catch a du code', () => {
    const { sf, name } = fileFromText(`
      export function f() {
        try {
          doSomething()
        } catch (e) {
          console.error(e)
        }
      }
    `)
    const { signals } = extractDriftPatternsFileBundle(sf, name)
    expect(signals.filter((s) => s.kind === 'empty-catch-no-comment')).toEqual([])
  })
})

describe('drift-patterns — todoToDriftSignal (pattern 3)', () => {
  function todo(message: string, tag: 'TODO' | 'FIXME' = 'TODO'): TodoMarker {
    return { tag, message, file: 'src/x.ts', line: 10 }
  }

  it('flag un TODO sans owner ni issue', () => {
    const s = todoToDriftSignal(todo('refactor this later'))
    expect(s).not.toBeNull()
    expect(s!.kind).toBe('todo-no-owner')
    expect(s!.message).toContain('TODO sans @owner ni #issue')
  })

  it('skip un TODO avec @user', () => {
    expect(todoToDriftSignal(todo('@alice will fix'))).toBeNull()
    expect(todoToDriftSignal(todo('(@bob) handle this'))).toBeNull()
  })

  it('skip un TODO avec #NNN issue ref', () => {
    expect(todoToDriftSignal(todo('see #123'))).toBeNull()
    expect(todoToDriftSignal(todo('#456 fix later'))).toBeNull()
  })

  it('skip si BOTH owner + issue', () => {
    expect(todoToDriftSignal(todo('@alice handles #99'))).toBeNull()
  })

  it('marche pour FIXME aussi', () => {
    const s = todoToDriftSignal(todo('broken behavior', 'FIXME'))
    expect(s).not.toBeNull()
    expect(s!.message).toContain('FIXME sans')
  })
})
