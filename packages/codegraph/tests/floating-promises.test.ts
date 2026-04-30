/**
 * Tests pour floating-promises extractor (Phase 4 Tier 4).
 */

import { describe, it, expect } from 'vitest'
import { Project } from 'ts-morph'
import { extractFloatingPromisesFileBundle } from '../src/extractors/floating-promises.js'

function fileFromText(text: string, name = 'src/test.ts') {
  const project = new Project({ useInMemoryFileSystem: true })
  const sf = project.createSourceFile(name, text)
  return { sf, name }
}

const ASYNC_NAMES = new Set(['fetchData', 'sendEmail', 'savedoc', 'doAsync'])

describe('floating-promises', () => {
  it('flag un call sans await/then/catch', () => {
    const { sf, name } = fileFromText(`
      export async function run() {
        fetchData()
      }
    `)
    const { sites } = extractFloatingPromisesFileBundle(sf, name, ASYNC_NAMES)
    expect(sites).toHaveLength(1)
    expect(sites[0].callee).toBe('fetchData')
  })

  it('skip si await', () => {
    const { sf, name } = fileFromText(`
      export async function run() {
        await fetchData()
      }
    `)
    const { sites } = extractFloatingPromisesFileBundle(sf, name, ASYNC_NAMES)
    expect(sites).toEqual([])
  })

  it('skip si .then chainé', () => {
    const { sf, name } = fileFromText(`
      export function run() {
        fetchData().then((x) => console.log(x))
      }
    `)
    const { sites } = extractFloatingPromisesFileBundle(sf, name, ASYNC_NAMES)
    expect(sites).toEqual([])
  })

  it('skip si .catch chainé', () => {
    const { sf, name } = fileFromText(`
      export function run() {
        fetchData().catch((e) => console.error(e))
      }
    `)
    const { sites } = extractFloatingPromisesFileBundle(sf, name, ASYNC_NAMES)
    expect(sites).toEqual([])
  })

  it('skip si return', () => {
    const { sf, name } = fileFromText(`
      export function run() {
        return fetchData()
      }
    `)
    const { sites } = extractFloatingPromisesFileBundle(sf, name, ASYNC_NAMES)
    expect(sites).toEqual([])
  })

  it('skip si assignement à une variable', () => {
    const { sf, name } = fileFromText(`
      export function run() {
        const p = fetchData()
        return p
      }
    `)
    const { sites } = extractFloatingPromisesFileBundle(sf, name, ASYNC_NAMES)
    expect(sites).toEqual([])
  })

  it('skip si void explicit', () => {
    const { sf, name } = fileFromText(`
      export function run() {
        void fetchData()
      }
    `)
    const { sites } = extractFloatingPromisesFileBundle(sf, name, ASYNC_NAMES)
    expect(sites).toEqual([])
  })

  it('skip si méthode passée en argument', () => {
    const { sf, name } = fileFromText(`
      export function run() {
        Promise.all([fetchData(), sendEmail()])
      }
    `)
    const { sites } = extractFloatingPromisesFileBundle(sf, name, ASYNC_NAMES)
    expect(sites).toEqual([])
  })

  it('skip si call non-async (pas dans le SET)', () => {
    const { sf, name } = fileFromText(`
      export function run() {
        synchronousFn()
      }
    `)
    const { sites } = extractFloatingPromisesFileBundle(sf, name, ASYNC_NAMES)
    expect(sites).toEqual([])
  })

  it('skip avec marker fire-and-forget', () => {
    const { sf, name } = fileFromText(`
      export async function run() {
        // fire-and-forget: telemetry envoyée en best-effort
        sendEmail()
      }
    `)
    const { sites } = extractFloatingPromisesFileBundle(sf, name, ASYNC_NAMES)
    expect(sites).toEqual([])
  })

  it('détecte property access (obj.fetchData())', () => {
    const { sf, name } = fileFromText(`
      const obj = { fetchData: async () => 1 }
      export function run() {
        obj.fetchData()
      }
    `)
    const { sites } = extractFloatingPromisesFileBundle(sf, name, ASYNC_NAMES)
    expect(sites).toHaveLength(1)
  })

  it('skip les fichiers de test', () => {
    const { sf, name } = fileFromText(
      `export function run() { fetchData() }`,
      'tests/foo.test.ts',
    )
    const { sites } = extractFloatingPromisesFileBundle(sf, name, ASYNC_NAMES)
    expect(sites).toEqual([])
  })
})
