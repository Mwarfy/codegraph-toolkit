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
