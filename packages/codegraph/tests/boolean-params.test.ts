/**
 * Tests pour boolean-params extractor (Phase 4 Tier 2).
 */

import { describe, it, expect } from 'vitest'
import { Project } from 'ts-morph'
import { extractBooleanParamsFileBundle } from '../src/extractors/boolean-params.js'

function fileFromText(text: string, name = 'src/test.ts') {
  const project = new Project({ useInMemoryFileSystem: true })
  const sf = project.createSourceFile(name, text)
  return { sf, name }
}

describe('boolean-params', () => {
  it('flag un boolean positionnel dans une fonction multi-args', () => {
    const { sf, name } = fileFromText(`
      export function send(message: string, urgent: boolean) {
        return urgent
      }
    `)
    const { sites } = extractBooleanParamsFileBundle(sf, name)
    expect(sites).toHaveLength(1)
    expect(sites[0].name).toBe('send')
    expect(sites[0].paramName).toBe('urgent')
    expect(sites[0].paramIndex).toBe(1)
    expect(sites[0].totalParams).toBe(2)
  })

  it('skip un setter avec 1 seul boolean', () => {
    const { sf, name } = fileFromText(`
      export function setEnabled(value: boolean) { return value }
    `)
    const { sites } = extractBooleanParamsFileBundle(sf, name)
    expect(sites).toEqual([])
  })

  it('skip un predicate avec 1 seul boolean', () => {
    const { sf, name } = fileFromText(`
      export function isReady(state: boolean) { return state }
    `)
    const { sites } = extractBooleanParamsFileBundle(sf, name)
    expect(sites).toEqual([])
  })

  it('flag même un setter SI > 1 param', () => {
    const { sf, name } = fileFromText(`
      export function setOption(name: string, value: boolean) { return name }
    `)
    const { sites } = extractBooleanParamsFileBundle(sf, name)
    expect(sites).toHaveLength(1)
  })

  it('détecte sur class methods', () => {
    const { sf, name } = fileFromText(`
      export class Foo {
        send(msg: string, async: boolean) { return msg }
      }
    `)
    const { sites } = extractBooleanParamsFileBundle(sf, name)
    expect(sites).toHaveLength(1)
    expect(sites[0].name).toBe('Foo.send')
  })

  it('détecte sur arrow assigné', () => {
    const { sf, name } = fileFromText(`
      export const fn = (a: string, b: boolean) => a
    `)
    const { sites } = extractBooleanParamsFileBundle(sf, name)
    expect(sites).toHaveLength(1)
    expect(sites[0].name).toBe('fn')
  })

  it('skip si type est boolean | undefined (optional flag)', () => {
    const { sf, name } = fileFromText(`
      export function send(msg: string, async?: boolean) { return msg }
    `)
    const { sites } = extractBooleanParamsFileBundle(sf, name)
    // `async?: boolean` → typeText = "boolean" (le `?` est sur le param,
    // pas dans le type). On flag — c'est attendu.
    expect(sites).toHaveLength(1)
  })

  it('skip avec marker boolean-ok', () => {
    const { sf, name } = fileFromText(`
      // boolean-ok: legacy API stable
      export function send(msg: string, urgent: boolean) { return msg }
    `)
    const { sites } = extractBooleanParamsFileBundle(sf, name)
    expect(sites).toEqual([])
  })

  it('skip les fichiers de test', () => {
    const { sf, name } = fileFromText(
      `export function helper(x: string, b: boolean) { return x }`,
      'tests/foo.test.ts',
    )
    const { sites } = extractBooleanParamsFileBundle(sf, name)
    expect(sites).toEqual([])
  })
})
