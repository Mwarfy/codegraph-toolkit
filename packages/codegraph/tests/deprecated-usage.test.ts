/**
 * Tests pour deprecated-usage extractor (Phase 4 Tier 4).
 */

import { describe, it, expect } from 'vitest'
import { Project } from 'ts-morph'
import { extractDeprecatedUsageFileBundle } from '../src/extractors/deprecated-usage.js'

function fileFromText(text: string, name = 'src/test.ts') {
  const project = new Project({ useInMemoryFileSystem: true })
  const sf = project.createSourceFile(name, text)
  return { sf, name }
}

describe('deprecated-usage — declarations detection', () => {
  it('détecte une function avec @deprecated', () => {
    const { sf, name } = fileFromText(`
      /**
       * @deprecated use newApi() instead
       */
      export function oldApi() { return 1 }
    `)
    const { declarations } = extractDeprecatedUsageFileBundle(sf, name, new Set())
    expect(declarations).toHaveLength(1)
    expect(declarations[0].name).toBe('oldApi')
    expect(declarations[0].reason).toContain('newApi')
  })

  it('détecte une class avec @deprecated', () => {
    const { sf, name } = fileFromText(`
      /** @deprecated */
      export class OldThing {}
    `)
    const { declarations } = extractDeprecatedUsageFileBundle(sf, name, new Set())
    expect(declarations).toHaveLength(1)
    expect(declarations[0].name).toBe('OldThing')
  })

  it('détecte une method @deprecated qualifiée Class.method', () => {
    const { sf, name } = fileFromText(`
      export class Foo {
        /** @deprecated */
        bar() { return 1 }
        baz() { return 2 }
      }
    `)
    const { declarations } = extractDeprecatedUsageFileBundle(sf, name, new Set())
    const namedDecls = declarations.map((d) => d.name).sort()
    expect(namedDecls).toEqual(['Foo.bar'])
  })

  it('ne flag PAS une fonction sans @deprecated', () => {
    const { sf, name } = fileFromText(`
      export function fresh() { return 1 }
    `)
    const { declarations } = extractDeprecatedUsageFileBundle(sf, name, new Set())
    expect(declarations).toEqual([])
  })
})

describe('deprecated-usage — call-sites detection', () => {
  it('flag un call-site qui matche un deprecated name', () => {
    const { sf, name } = fileFromText(`
      export function consumer() {
        oldApi()
      }
    `)
    const deprecatedNames = new Set(['oldApi'])
    const { sites } = extractDeprecatedUsageFileBundle(sf, name, deprecatedNames)
    expect(sites).toHaveLength(1)
    expect(sites[0].callee).toBe('oldApi')
  })

  it('flag un new Expression qui matche', () => {
    const { sf, name } = fileFromText(`
      export function consumer() {
        return new OldThing()
      }
    `)
    const deprecatedNames = new Set(['OldThing'])
    const { sites } = extractDeprecatedUsageFileBundle(sf, name, deprecatedNames)
    expect(sites).toHaveLength(1)
  })

  it('flag un property access (obj.deprecatedMethod())', () => {
    const { sf, name } = fileFromText(`
      export function consumer() {
        someObj.bar()
      }
    `)
    const deprecatedNames = new Set(['bar'])
    const { sites } = extractDeprecatedUsageFileBundle(sf, name, deprecatedNames)
    expect(sites).toHaveLength(1)
  })

  it('skip avec marker deprecated-ok', () => {
    const { sf, name } = fileFromText(`
      export function migration() {
        // deprecated-ok: read old values pour piloter la migration
        oldApi()
      }
    `)
    const deprecatedNames = new Set(['oldApi'])
    const { sites } = extractDeprecatedUsageFileBundle(sf, name, deprecatedNames)
    expect(sites).toEqual([])
  })

  it('skip les fichiers de test', () => {
    const { sf, name } = fileFromText(
      `export function consumer() { oldApi() }`,
      'tests/foo.test.ts',
    )
    const deprecatedNames = new Set(['oldApi'])
    const { sites } = extractDeprecatedUsageFileBundle(sf, name, deprecatedNames)
    expect(sites).toEqual([])
  })
})
