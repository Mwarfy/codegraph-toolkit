/**
 * Tests pour code-quality-patterns extractor (Phase 5 Tier 17).
 *
 * Couvre les 4 sous-détecteurs après le split en _internal/code-quality/ :
 *   - regex-literals (incl. fix bug NESTED_QUANTIFIER_RE)
 *   - try-catch-swallow
 *   - await-in-loop
 *   - allocation-in-loop
 */

import { describe, it, expect } from 'vitest'
import { Project } from 'ts-morph'
import { extractCodeQualityPatternsFileBundle } from '../src/extractors/code-quality-patterns.js'

function fileFromText(text: string, name = 'src/test.ts') {
  const project = new Project({ useInMemoryFileSystem: true })
  const sf = project.createSourceFile(name, text)
  return { sf, name }
}

describe('code-quality-patterns / regex-literals', () => {
  it('capture un RegExpLiteral basique', () => {
    const { sf, name } = fileFromText(`
      const re = /foo/g
    `)
    const out = extractCodeQualityPatternsFileBundle(sf, name)
    expect(out.regexLiterals).toHaveLength(1)
    expect(out.regexLiterals[0].source).toBe('foo')
    expect(out.regexLiterals[0].flags).toBe('g')
    expect(out.regexLiterals[0].hasNestedQuantifier).toBe(false)
  })

  it('capture un new RegExp(literal, flags)', () => {
    const { sf, name } = fileFromText(`
      const re = new RegExp("foo", "g")
    `)
    const out = extractCodeQualityPatternsFileBundle(sf, name)
    expect(out.regexLiterals).toHaveLength(1)
    expect(out.regexLiterals[0].source).toBe('foo')
    expect(out.regexLiterals[0].flags).toBe('g')
  })

  it('flag (a+)+ comme nested quantifier (catastrophic)', () => {
    const { sf, name } = fileFromText(`
      const re = /(a+)+/
    `)
    const out = extractCodeQualityPatternsFileBundle(sf, name)
    expect(out.regexLiterals[0].hasNestedQuantifier).toBe(true)
  })

  it('flag (a*)* comme nested quantifier (catastrophic)', () => {
    const { sf, name } = fileFromText(`
      const re = /(a*)*/
    `)
    const out = extractCodeQualityPatternsFileBundle(sf, name)
    expect(out.regexLiterals[0].hasNestedQuantifier).toBe(true)
  })

  it('NE FLAG PAS (?:foo*)? — groupe optionnel bénin (regression test bug fix)', () => {
    // Bug historique : l'ancienne heuristique `\\([^)]*[+*]\\)[+*?]`
    // matchait `(?:foo*)?` parce que `?` était dans le character class
    // trailing. Mais un groupe optionnel ne répète pas son contenu —
    // il est présent OU absent, donc bénin (pas catastrophic backtracking).
    const { sf, name } = fileFromText(`
      const re = /(?:foo*)?bar/
    `)
    const out = extractCodeQualityPatternsFileBundle(sf, name)
    expect(out.regexLiterals[0].hasNestedQuantifier).toBe(false)
  })

  it('NE FLAG PAS (a+)? — groupe avec répétition mais optionnel', () => {
    const { sf, name } = fileFromText(`
      const re = /(a+)?b/
    `)
    const out = extractCodeQualityPatternsFileBundle(sf, name)
    expect(out.regexLiterals[0].hasNestedQuantifier).toBe(false)
  })

  it('respecte // regex-ok pour skipper un literal', () => {
    const { sf, name } = fileFromText(`
      // regex-ok intentional pattern
      const re = /(a+)+/
    `)
    const out = extractCodeQualityPatternsFileBundle(sf, name)
    expect(out.regexLiterals).toHaveLength(0)
  })
})

describe('code-quality-patterns / try-catch-swallow', () => {
  it('flag un catch vide sans commentaire', () => {
    const { sf, name } = fileFromText(`
      export function f() {
        try { doStuff() } catch (e) {}
      }
    `)
    const out = extractCodeQualityPatternsFileBundle(sf, name)
    expect(out.tryCatchSwallows).toHaveLength(1)
    expect(out.tryCatchSwallows[0].kind).toBe('empty')
  })

  it('NE FLAG PAS un catch vide AVEC commentaire (intentionnel documenté)', () => {
    const { sf, name } = fileFromText(`
      export function f() {
        try { doStuff() } catch (e) { /* best-effort: ignore failures */ }
      }
    `)
    const out = extractCodeQualityPatternsFileBundle(sf, name)
    expect(out.tryCatchSwallows).toHaveLength(0)
  })

  it('flag un catch log-only sans rethrow', () => {
    const { sf, name } = fileFromText(`
      export function f() {
        try { doStuff() } catch (e) { console.error(e) }
      }
    `)
    const out = extractCodeQualityPatternsFileBundle(sf, name)
    expect(out.tryCatchSwallows).toHaveLength(1)
    expect(out.tryCatchSwallows[0].kind).toBe('log-only')
  })

  it('NE FLAG PAS un catch qui rethrow', () => {
    const { sf, name } = fileFromText(`
      export function f() {
        try { doStuff() } catch (e) { console.error(e); throw e }
      }
    `)
    const out = extractCodeQualityPatternsFileBundle(sf, name)
    expect(out.tryCatchSwallows).toHaveLength(0)
  })

  it('flag un catch no-rethrow custom', () => {
    const { sf, name } = fileFromText(`
      export function f() {
        try { doStuff() } catch (e) { handleError(e); cleanup() }
      }
    `)
    const out = extractCodeQualityPatternsFileBundle(sf, name)
    expect(out.tryCatchSwallows).toHaveLength(1)
    expect(out.tryCatchSwallows[0].kind).toBe('no-rethrow')
  })

  it('respecte // catch-ok au-dessus du try', () => {
    const { sf, name } = fileFromText(`
      export function f() {
        // catch-ok probe pattern
        try { doStuff() } catch (e) {}
      }
    `)
    const out = extractCodeQualityPatternsFileBundle(sf, name)
    expect(out.tryCatchSwallows).toHaveLength(0)
  })
})

describe('code-quality-patterns / await-in-loop', () => {
  it('flag await dans un for direct', () => {
    const { sf, name } = fileFromText(`
      export async function f(items: any[]) {
        for (const it of items) {
          await fetch(it)
        }
      }
    `)
    const out = extractCodeQualityPatternsFileBundle(sf, name)
    expect(out.awaitInLoops).toHaveLength(1)
    expect(out.awaitInLoops[0].loopKind).toBe('ForOfStatement')
  })

  it('flag await dans un while', () => {
    const { sf, name } = fileFromText(`
      export async function f() {
        while (cond()) {
          await tick()
        }
      }
    `)
    const out = extractCodeQualityPatternsFileBundle(sf, name)
    expect(out.awaitInLoops).toHaveLength(1)
    expect(out.awaitInLoops[0].loopKind).toBe('WhileStatement')
  })

  it('NE FLAG PAS await dans une fn nested DANS le loop (Promise.all-style)', () => {
    const { sf, name } = fileFromText(`
      export async function f(items: any[]) {
        await Promise.all(items.map(async (it) => {
          await fetch(it)
        }))
      }
    `)
    const out = extractCodeQualityPatternsFileBundle(sf, name)
    expect(out.awaitInLoops).toHaveLength(0)
  })

  it('respecte // await-ok', () => {
    const { sf, name } = fileFromText(`
      export async function f(items: any[]) {
        for (const it of items) {
          // await-ok sequential by design
          await fetch(it)
        }
      }
    `)
    const out = extractCodeQualityPatternsFileBundle(sf, name)
    expect(out.awaitInLoops).toHaveLength(0)
  })
})

describe('code-quality-patterns / allocation-in-loop', () => {
  it('flag array literal dans le body du loop', () => {
    const { sf, name } = fileFromText(`
      export function f(n: number) {
        const out = []
        for (let i = 0; i < n; i++) {
          const tmp = [1, 2, 3]
          out.push(tmp)
        }
        return out
      }
    `)
    const out = extractCodeQualityPatternsFileBundle(sf, name)
    const arrayAllocs = out.allocationInLoops.filter((a) => a.allocKind === 'array-literal')
    expect(arrayAllocs).toHaveLength(1)
  })

  it('NE FLAG PAS le iterable du for-of (évalué une fois, pas par-iter)', () => {
    const { sf, name } = fileFromText(`
      export function f() {
        for (const x of [1, 2, 3]) {
          use(x)
        }
      }
    `)
    const out = extractCodeQualityPatternsFileBundle(sf, name)
    expect(out.allocationInLoops).toHaveLength(0)
  })

  it('flag new Expression dans le body', () => {
    const { sf, name } = fileFromText(`
      export function f(n: number) {
        for (let i = 0; i < n; i++) {
          const m = new Map()
          m.set(i, i)
        }
      }
    `)
    const out = extractCodeQualityPatternsFileBundle(sf, name)
    const newAllocs = out.allocationInLoops.filter((a) => a.allocKind === 'new-expression')
    expect(newAllocs).toHaveLength(1)
  })

  it('respecte // alloc-ok', () => {
    const { sf, name } = fileFromText(`
      export function f(n: number) {
        for (let i = 0; i < n; i++) {
          // alloc-ok intentional fresh array per row
          const row = [i, i + 1, i + 2]
          consume(row)
        }
      }
    `)
    const out = extractCodeQualityPatternsFileBundle(sf, name)
    expect(out.allocationInLoops).toHaveLength(0)
  })
})

describe('code-quality-patterns / file-level filters', () => {
  it('skip les fichiers de test', () => {
    const { sf } = fileFromText(`
      const re = /(a+)+/
      try {} catch {}
    `, 'src/foo.test.ts')
    const out = extractCodeQualityPatternsFileBundle(sf, 'src/foo.test.ts')
    expect(out.regexLiterals).toHaveLength(0)
    expect(out.tryCatchSwallows).toHaveLength(0)
  })

  it('skip les fichiers fixtures', () => {
    const { sf } = fileFromText(`
      const re = /(a+)+/
    `, 'tests/fixtures/sample.ts')
    const out = extractCodeQualityPatternsFileBundle(sf, 'tests/fixtures/sample.ts')
    expect(out.regexLiterals).toHaveLength(0)
  })
})
