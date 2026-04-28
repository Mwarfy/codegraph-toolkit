/**
 * Contract tests pour `linker` — file → ADRs[].
 *
 * Le matcher est strict (suffix-match exige `/` — sinon `index.ts` matcherait
 * 50 fichiers). Cas known-good portés depuis Sentinel.
 */

import { describe, it, expect } from 'vitest'
import { matches } from '../src/linker.js'

describe('linker.matches', () => {
  describe('match identique', () => {
    it('matche path exact', () => {
      expect(matches('src/foo.ts', 'src/foo.ts')).toBe(true)
    })
    it('strip leading ./', () => {
      expect(matches('./src/foo.ts', 'src/foo.ts')).toBe(true)
      expect(matches('src/foo.ts', './src/foo.ts')).toBe(true)
    })
  })

  describe('suffix match (anchor avec /)', () => {
    it('matche si filePath se termine par /anchor', () => {
      expect(matches('mono/src/foo.ts', 'src/foo.ts')).toBe(true)
    })
    it('matche dans l\'autre sens (filePath plus court)', () => {
      expect(matches('src/foo.ts', 'project/src/foo.ts')).toBe(true)
    })
  })

  describe('pas de suffix-match sans /', () => {
    it('"index.ts" NE matche PAS "src/index.ts"', () => {
      expect(matches('src/index.ts', 'index.ts')).toBe(false)
    })
    it('"foo.ts" NE matche PAS "bar/foo.ts"', () => {
      expect(matches('bar/foo.ts', 'foo.ts')).toBe(false)
    })
    it('"foo.ts" matche "foo.ts" identique uniquement', () => {
      expect(matches('foo.ts', 'foo.ts')).toBe(true)
    })
  })

  describe('glob simple via *', () => {
    it('matche packs/*/index.ts', () => {
      expect(matches('packs/visual/index.ts', 'packs/*/index.ts')).toBe(true)
    })
    it('ne matche PAS si segment manquant', () => {
      expect(matches('packs/index.ts', 'packs/*/index.ts')).toBe(false)
    })
  })

  describe('non-match', () => {
    it('paths totalement différents', () => {
      expect(matches('src/foo.ts', 'src/bar.ts')).toBe(false)
    })
    it('extensions différentes', () => {
      expect(matches('src/foo.ts', 'src/foo.tsx')).toBe(false)
    })
  })
})
