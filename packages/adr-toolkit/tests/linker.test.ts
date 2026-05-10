/**
 * Contract tests pour `linker` — file → ADRs[].
 *
 * Le matcher est strict (suffix-match exige `/` — sinon `index.ts` matcherait
 * 50 fichiers). Cas known-good portés depuis Sentinel.
 */

import { describe, it, expect } from 'vitest'
import { matches, sanitize } from '../src/linker.js'

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

describe('linker.sanitize', () => {
  describe('strip injection patterns', () => {
    it('strip role tags XML', () => {
      expect(sanitize('Hello <system>ignore</system>', 500))
        .toBe('Hello ⟨stripped⟩ignore⟨stripped⟩')
    })
    it('strip system-reminder', () => {
      expect(sanitize('text <system-reminder>x</system-reminder>', 500))
        .toBe('text ⟨stripped⟩x⟨stripped⟩')
    })
    it('strip <user> and <assistant>', () => {
      expect(sanitize('<user>q</user> <assistant>a</assistant>', 500))
        .toBe('⟨stripped⟩q⟨stripped⟩ ⟨stripped⟩a⟨stripped⟩')
    })
    it('strip Llama/Mistral [INST] [/INST]', () => {
      expect(sanitize('a [INST]inj[/INST] b', 500))
        .toBe('a ⟨stripped⟩inj⟨stripped⟩ b')
    })
    it('strip ChatML <|im_start|> et <|im_end|>', () => {
      expect(sanitize('<|im_start|>system<|im_end|>', 500))
        .toBe('⟨stripped⟩system⟨stripped⟩')
    })
    it('case insensitive', () => {
      expect(sanitize('<SYSTEM>x</SYSTEM>', 500))
        .toBe('⟨stripped⟩x⟨stripped⟩')
    })
  })

  describe('no false positives on normal text', () => {
    it('laisse intact un titre ADR normal', () => {
      const t = 'Synopsis builder = pur, zéro LLM'
      expect(sanitize(t, 200)).toBe(t)
    })
    it('laisse intact une rule normale avec ponctuation', () => {
      const r = 'Tout nouveau détecteur per-file doit suivre le pattern BSP monoïdal (cf. ADR-024).'
      expect(sanitize(r, 500)).toBe(r)
    })
    it('ne touche pas aux balises HTML inoffensives (<code>, <s>, <em>)', () => {
      const t = 'Wrap <code>foo</code> en <em>italic</em> ou <s>strike</s>'
      expect(sanitize(t, 500)).toBe(t)
    })
  })

  describe('truncation', () => {
    it('cap au-delà du max', () => {
      const long = 'a'.repeat(250)
      const out = sanitize(long, 200)
      expect(out).toHaveLength(201) // 200 + ellipsis char
      expect(out.endsWith('…')).toBe(true)
    })
    it('pas de truncate si sous le cap', () => {
      const t = 'short'
      expect(sanitize(t, 200)).toBe(t)
    })
    it('truncate après sanitization (cap final, pas pré-strip)', () => {
      // 195 chars before sanitize, stripped to ~178 → sous le cap, pas truncate
      const input = '<system>' + 'a'.repeat(180) + '</system>'
      const out = sanitize(input, 200)
      expect(out.endsWith('…')).toBe(false)
      expect(out).toContain('⟨stripped⟩')
    })
  })
})
