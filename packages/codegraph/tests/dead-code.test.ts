/**
 * Tests pour dead-code extractor (Phase 4 Tier 3).
 */

import { describe, it, expect } from 'vitest'
import { Project } from 'ts-morph'
import { extractDeadCodeFileBundle } from '../src/extractors/dead-code.js'

function fileFromText(text: string, name = 'src/test.ts') {
  const project = new Project({ useInMemoryFileSystem: true })
  const sf = project.createSourceFile(name, text)
  return { sf, name }
}

describe('dead-code — identical-subexpressions', () => {
  it('flag && avec les 2 cotes identiques', () => {
    const { sf, name } = fileFromText(`
      export function f(a: number) {
        if (a > 0 && a > 0) return true
        return false
      }
    `)
    const { findings } = extractDeadCodeFileBundle(sf, name)
    const f = findings.find((x) => x.kind === 'identical-subexpressions')
    expect(f).toBeDefined()
    expect(f!.details!.operator).toBe('&&')
  })

  it('flag === avec les 2 cotes identiques', () => {
    const { sf, name } = fileFromText(`
      export function f(x: number) { return x === x }
    `)
    const { findings } = extractDeadCodeFileBundle(sf, name)
    expect(findings.find((x) => x.kind === 'identical-subexpressions')).toBeDefined()
  })

  it('flag >= identiques', () => {
    const { sf, name } = fileFromText(`
      export function f(a: any) { return a.score >= a.score }
    `)
    const { findings } = extractDeadCodeFileBundle(sf, name)
    expect(findings.find((x) => x.kind === 'identical-subexpressions')).toBeDefined()
  })

  it('ne flag PAS quand les cotes different', () => {
    const { sf, name } = fileFromText(`
      export function f(a: number, b: number) {
        return a > 0 && b > 0
      }
    `)
    const { findings } = extractDeadCodeFileBundle(sf, name)
    expect(findings.filter((x) => x.kind === 'identical-subexpressions')).toEqual([])
  })

  it('ne flag PAS les + - / * (peuvent etre legitimes)', () => {
    const { sf, name } = fileFromText(`
      export function f(x: number) { return x + x }
    `)
    const { findings } = extractDeadCodeFileBundle(sf, name)
    expect(findings.filter((x) => x.kind === 'identical-subexpressions')).toEqual([])
  })

  it('skip les literals courts (0 === 0)', () => {
    const { sf, name } = fileFromText(`
      export const t = 0 === 0
    `)
    const { findings } = extractDeadCodeFileBundle(sf, name)
    expect(findings.filter((x) => x.kind === 'identical-subexpressions')).toEqual([])
  })

  it('flag si exempt absent', () => {
    const { sf, name } = fileFromText(`
      // dead-code-ok: comparaison intentionnelle pour test NaN
      export function f(x: number) { return x === x }
    `)
    const { findings } = extractDeadCodeFileBundle(sf, name)
    expect(findings.filter((x) => x.kind === 'identical-subexpressions')).toEqual([])
  })
})

describe('dead-code — return-then-else', () => {
  it('flag if/return + else (single statement then)', () => {
    const { sf, name } = fileFromText(`
      export function f(x: number) {
        if (x > 0) return x
        else { return -x }
      }
    `)
    const { findings } = extractDeadCodeFileBundle(sf, name)
    expect(findings.find((x) => x.kind === 'return-then-else')).toBeDefined()
  })

  it('flag if/return + else (block avec return final)', () => {
    const { sf, name } = fileFromText(`
      export function f(x: number) {
        if (x > 0) {
          console.log('positive')
          return x
        } else {
          return -x
        }
      }
    `)
    const { findings } = extractDeadCodeFileBundle(sf, name)
    expect(findings.find((x) => x.kind === 'return-then-else')).toBeDefined()
  })

  it('flag if/throw + else', () => {
    const { sf, name } = fileFromText(`
      export function f(x: number) {
        if (x < 0) throw new Error('negative')
        else return x
      }
    `)
    const { findings } = extractDeadCodeFileBundle(sf, name)
    expect(findings.find((x) => x.kind === 'return-then-else')).toBeDefined()
  })

  it('skip else if (pattern lisible)', () => {
    const { sf, name } = fileFromText(`
      export function f(x: number) {
        if (x > 0) return x
        else if (x < 0) return -x
        return 0
      }
    `)
    const { findings } = extractDeadCodeFileBundle(sf, name)
    expect(findings.filter((x) => x.kind === 'return-then-else')).toEqual([])
  })

  it('skip si pas de else', () => {
    const { sf, name } = fileFromText(`
      export function f(x: number) {
        if (x > 0) return x
        return -x
      }
    `)
    const { findings } = extractDeadCodeFileBundle(sf, name)
    expect(findings.filter((x) => x.kind === 'return-then-else')).toEqual([])
  })

  it('skip si then ne return pas', () => {
    const { sf, name } = fileFromText(`
      export function f(x: number) {
        if (x > 0) {
          console.log('positive')
        } else {
          console.log('negative')
        }
        return x
      }
    `)
    const { findings } = extractDeadCodeFileBundle(sf, name)
    expect(findings.filter((x) => x.kind === 'return-then-else')).toEqual([])
  })

  it('flag si dernier statement du then = throw', () => {
    const { sf, name } = fileFromText(`
      export function f(x: number) {
        if (x < 0) {
          x = -x
          throw new Error('was negative')
        } else {
          return x
        }
      }
    `)
    const { findings } = extractDeadCodeFileBundle(sf, name)
    expect(findings.find((x) => x.kind === 'return-then-else')).toBeDefined()
  })
})

describe('dead-code — exemptions', () => {
  it('skip les fichiers de test', () => {
    const { sf, name } = fileFromText(
      `export function f(x: number) { return x === x }`,
      'tests/foo.test.ts',
    )
    const { findings } = extractDeadCodeFileBundle(sf, name)
    expect(findings).toEqual([])
  })
})

describe('dead-code — switch-fallthrough (Tier 4)', () => {
  it('flag un case sans break/return/throw', () => {
    const { sf, name } = fileFromText(`
      export function f(x: string) {
        switch (x) {
          case 'a':
            doStuff()
          case 'b':
            return 1
        }
        return 0
      }
    `)
    const { findings } = extractDeadCodeFileBundle(sf, name)
    const f = findings.find((x) => x.kind === 'switch-fallthrough')
    expect(f).toBeDefined()
  })

  it('skip un case avec break', () => {
    const { sf, name } = fileFromText(`
      export function f(x: string) {
        switch (x) {
          case 'a':
            doStuff()
            break
          case 'b':
            return 1
        }
      }
    `)
    const { findings } = extractDeadCodeFileBundle(sf, name)
    expect(findings.filter((x) => x.kind === 'switch-fallthrough')).toEqual([])
  })

  it('skip un case avec return', () => {
    const { sf, name } = fileFromText(`
      export function f(x: string) {
        switch (x) {
          case 'a':
            return 'A'
          case 'b':
            return 'B'
        }
      }
    `)
    const { findings } = extractDeadCodeFileBundle(sf, name)
    expect(findings.filter((x) => x.kind === 'switch-fallthrough')).toEqual([])
  })

  it('skip un case vide (groupage explicite)', () => {
    const { sf, name } = fileFromText(`
      export function f(x: string) {
        switch (x) {
          case 'a':
          case 'b':
          case 'c':
            return 'group'
        }
      }
    `)
    const { findings } = extractDeadCodeFileBundle(sf, name)
    expect(findings.filter((x) => x.kind === 'switch-fallthrough')).toEqual([])
  })

  it('skip avec comment // fallthrough', () => {
    const { sf, name } = fileFromText(`
      export function f(x: string) {
        switch (x) {
          case 'a':
            doStuff()
            // fallthrough
          case 'b':
            return 1
        }
      }
    `)
    const { findings } = extractDeadCodeFileBundle(sf, name)
    expect(findings.filter((x) => x.kind === 'switch-fallthrough')).toEqual([])
  })

  it('skip le DERNIER case (pas de fall-through possible)', () => {
    const { sf, name } = fileFromText(`
      export function f(x: string) {
        switch (x) {
          case 'a':
            return 1
          case 'b':
            doStuff()
        }
      }
    `)
    const { findings } = extractDeadCodeFileBundle(sf, name)
    expect(findings.filter((x) => x.kind === 'switch-fallthrough')).toEqual([])
  })
})

describe('dead-code — switch-empty / switch-no-default (Tier 6)', () => {
  it('flag un switch vide', () => {
    const { sf, name } = fileFromText(`
      export function f(x: string) {
        switch (x) {}
      }
    `)
    const { findings } = extractDeadCodeFileBundle(sf, name)
    expect(findings.find((x) => x.kind === 'switch-empty')).toBeDefined()
  })

  it('flag un switch sans default', () => {
    const { sf, name } = fileFromText(`
      export function f(x: string) {
        switch (x) {
          case 'a': return 1
          case 'b': return 2
        }
      }
    `)
    const { findings } = extractDeadCodeFileBundle(sf, name)
    expect(findings.find((x) => x.kind === 'switch-no-default')).toBeDefined()
  })

  it('skip un switch avec default', () => {
    const { sf, name } = fileFromText(`
      export function f(x: string) {
        switch (x) {
          case 'a': return 1
          default: return 0
        }
      }
    `)
    const { findings } = extractDeadCodeFileBundle(sf, name)
    expect(findings.filter((x) => x.kind === 'switch-no-default')).toEqual([])
  })
})

describe('dead-code — controlling-expression-constant (Tier 6)', () => {
  it('flag if (true)', () => {
    const { sf, name } = fileFromText(`
      export function f() {
        if (true) doStuff()
      }
    `)
    const { findings } = extractDeadCodeFileBundle(sf, name)
    expect(findings.find((x) => x.kind === 'controlling-expression-constant')).toBeDefined()
  })

  it('flag if (false)', () => {
    const { sf, name } = fileFromText(`
      export function f() {
        if (false) deadBranch()
      }
    `)
    const { findings } = extractDeadCodeFileBundle(sf, name)
    expect(findings.find((x) => x.kind === 'controlling-expression-constant')).toBeDefined()
  })

  it('flag if (true && X)', () => {
    const { sf, name } = fileFromText(`
      export function f(x: number) {
        if (true && x > 0) doStuff()
      }
    `)
    const { findings } = extractDeadCodeFileBundle(sf, name)
    expect(findings.find((x) => x.kind === 'controlling-expression-constant')).toBeDefined()
  })

  it('flag if (X || true)', () => {
    const { sf, name } = fileFromText(`
      export function f(x: number) {
        if (x > 0 || true) doStuff()
      }
    `)
    const { findings } = extractDeadCodeFileBundle(sf, name)
    expect(findings.find((x) => x.kind === 'controlling-expression-constant')).toBeDefined()
  })

  it('skip if (cond) normal', () => {
    const { sf, name } = fileFromText(`
      export function f(x: number) {
        if (x > 0) doStuff()
      }
    `)
    const { findings } = extractDeadCodeFileBundle(sf, name)
    expect(findings.filter((x) => x.kind === 'controlling-expression-constant')).toEqual([])
  })

  it('flag dans ternary', () => {
    const { sf, name } = fileFromText(`
      export const v = true ? 1 : 2
    `)
    const { findings } = extractDeadCodeFileBundle(sf, name)
    expect(findings.find((x) => x.kind === 'controlling-expression-constant')).toBeDefined()
  })
})
