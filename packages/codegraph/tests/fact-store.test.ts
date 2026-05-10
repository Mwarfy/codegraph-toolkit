// ADR-027
/**
 * Tests pour le content-addressed fact store (Phase 3 d'ADR-027).
 * Couvre :
 *   - canonicalJson : keys triées récursivement, stable
 *   - computeFactId : déterministe par construction
 *   - buildFactsHead : dédup intra-bundle, tri lex
 *   - writeFactStore : append-only, dédup cross-runs, atomic head
 *   - computeDelta : added/removed corrects, symétrie
 *   - saveBase / loadBase : round-trip
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  canonicalJson,
  computeFactId,
  buildFactsHead,
  writeFactStore,
  readFactsHead,
  computeDelta,
  saveBase,
  loadBase,
  factStorePath,
  factsHeadPath,
  FACT_STORE_VERSION,
} from '../src/incremental/fact-store.js'
import type { AstFactsBundle } from '../src/datalog-detectors/ast-facts/types.js'

function emptyBundle(): AstFactsBundle {
  return {
    numericLiterals: [],
    binaryExpressions: [],
    exemptionLines: [],
    fileTags: [],
    callExpressions: [],
    functionScopes: [],
    functionParams: [],
    sanitizerCandidates: [],
    taintSinkCandidates: [],
    longFunctionCandidates: [],
    functionComplexities: [],
    hardcodedSecretCandidates: [],
    eventListenerSiteCandidates: [],
    barrelFiles: [],
    importEdges: [],
    envVarReads: [],
    constantExpressionCandidates: [],
    taintedArgumentCandidates: [],
    eventEmitSiteCandidates: [],
    taintedVarDeclCandidates: [],
    taintedVarArgCallCandidates: [],
    resourceImbalanceCandidates: [],
    secretVarRefCandidates: [],
    corsConfigCandidates: [],
    tlsUnsafeCandidates: [],
    weakRandomCandidates: [],
    excessiveOptionalParamsCandidates: [],
    wrapperSuperfluousCandidates: [],
    deepNestingCandidates: [],
    emptyCatchNoCommentCandidates: [],
    regexLiteralCandidates: [],
    tryCatchSwallowCandidates: [],
    awaitInLoopCandidates: [],
    allocationInLoopCandidates: [],
    deadCodeFindings: [],
  }
}

describe('canonicalJson — ADR-027 Phase 3', () => {
  it('produit la même string quel que soit l\'ordre des keys', () => {
    const a = canonicalJson({ b: 2, a: 1, c: 3 })
    const b = canonicalJson({ c: 3, a: 1, b: 2 })
    expect(a).toBe(b)
  })

  it('tri récursif sur objets imbriqués', () => {
    const a = canonicalJson({ outer: { z: 1, a: 2 } })
    const b = canonicalJson({ outer: { a: 2, z: 1 } })
    expect(a).toBe(b)
  })

  it('préserve l\'ordre des arrays (sémantique)', () => {
    const a = canonicalJson([3, 1, 2])
    expect(a).toBe('[3,1,2]')
  })

  it('gère null + undefined', () => {
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson(undefined)).toBe(undefined)
  })
})

describe('computeFactId — ADR-027 Phase 3', () => {
  it('déterministe : 2 appels → même hash', () => {
    const id1 = computeFactId('NumericLiteralAst', { file: 'x.ts', line: 10 })
    const id2 = computeFactId('NumericLiteralAst', { file: 'x.ts', line: 10 })
    expect(id1).toBe(id2)
  })

  it('hash différent si relation diffère', () => {
    const a = computeFactId('NumericLiteralAst', { file: 'x.ts' })
    const b = computeFactId('BinaryExpressionAst', { file: 'x.ts' })
    expect(a).not.toBe(b)
  })

  it('hash identique pour values mêmes contenus / ordre keys différent', () => {
    const a = computeFactId('NumericLiteralAst', { file: 'x.ts', line: 10 })
    const b = computeFactId('NumericLiteralAst', { line: 10, file: 'x.ts' })
    expect(a).toBe(b)
  })

  it('hex sha256 de 64 chars', () => {
    const id = computeFactId('R', { x: 1 })
    expect(id).toMatch(/^[a-f0-9]{64}$/)
  })
})

describe('buildFactsHead — ADR-027 Phase 3', () => {
  it('dédup intra-bundle : 2 tuples identiques → 1 fact_id', () => {
    const b = emptyBundle()
    b.numericLiterals.push(
      { file: 'a.ts', line: 1, valueText: '1', valueAbs: 1, parentKind: 'Other', parentName: '', parentArgIdx: -1, isScreamingSnake: 0, isRatio: 0, isTrivial: 0 } as never,
      { file: 'a.ts', line: 1, valueText: '1', valueAbs: 1, parentKind: 'Other', parentName: '', parentArgIdx: -1, isScreamingSnake: 0, isRatio: 0, isTrivial: 0 } as never,
    )
    const { head, records } = buildFactsHead(b, { generatedAt: '2026-05-11T00:00:00.000Z' })
    expect(head.byRelation['numericLiterals']).toHaveLength(1)
    expect(records).toHaveLength(1)
  })

  it('factSetHash insensible à l\'ordre des tuples dans le bundle', () => {
    const b1 = emptyBundle()
    const f1 = { file: 'a.ts', line: 1, valueText: '1', valueAbs: 1, parentKind: 'Other', parentName: '', parentArgIdx: -1, isScreamingSnake: 0, isRatio: 0, isTrivial: 0 } as never
    const f2 = { file: 'b.ts', line: 2, valueText: '2', valueAbs: 2, parentKind: 'Other', parentName: '', parentArgIdx: -1, isScreamingSnake: 0, isRatio: 0, isTrivial: 0 } as never
    b1.numericLiterals.push(f1, f2)

    const b2 = emptyBundle()
    b2.numericLiterals.push(f2, f1)  // ordre inversé

    const h1 = buildFactsHead(b1, { generatedAt: 'x' })
    const h2 = buildFactsHead(b2, { generatedAt: 'x' })
    expect(h2.head.factSetHash).toBe(h1.head.factSetHash)
  })

  it('byRelation : ids triés lex', () => {
    const b = emptyBundle()
    for (let i = 0; i < 5; i++) {
      b.numericLiterals.push({
        file: `f${i}.ts`, line: i, valueText: String(i), valueAbs: i,
        parentKind: 'Other', parentName: '', parentArgIdx: -1,
        isScreamingSnake: 0, isRatio: 0, isTrivial: 0,
      } as never)
    }
    const { head } = buildFactsHead(b, { generatedAt: 'x' })
    const ids = head.byRelation['numericLiterals']
    expect(ids).toEqual([...ids].sort())
  })
})

describe('writeFactStore + readFactsHead — ADR-027 Phase 3', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fact-store-'))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('append-only : 2e write ne re-ajoute pas les facts existants', async () => {
    const b = emptyBundle()
    b.numericLiterals.push({
      file: 'x.ts', line: 1, valueText: '1', valueAbs: 1, parentKind: 'Other',
      parentName: '', parentArgIdx: -1, isScreamingSnake: 0, isRatio: 0, isTrivial: 0,
    } as never)
    const { head, records } = buildFactsHead(b, { generatedAt: 'x' })

    const r1 = await writeFactStore(dir, head, records)
    expect(r1.added).toBe(1)
    expect(r1.existing).toBe(0)

    const r2 = await writeFactStore(dir, head, records)
    expect(r2.added).toBe(0)
    expect(r2.existing).toBe(1)

    const lines = (await fs.readFile(factStorePath(dir), 'utf-8')).split('\n').filter((l) => l)
    expect(lines).toHaveLength(1)
  })

  it('head atomiquement réécrit (tmp + rename)', async () => {
    const b = emptyBundle()
    b.numericLiterals.push({
      file: 'x.ts', line: 1, valueText: '1', valueAbs: 1, parentKind: 'Other',
      parentName: '', parentArgIdx: -1, isScreamingSnake: 0, isRatio: 0, isTrivial: 0,
    } as never)
    const out = buildFactsHead(b, { generatedAt: 'x' })
    await writeFactStore(dir, out.head, out.records)

    const read = await readFactsHead(dir)
    expect(read?.factSetHash).toBe(out.head.factSetHash)
    expect(read?.version).toBe(FACT_STORE_VERSION)
  })

  it('readFactsHead null si fichier absent', async () => {
    const read = await readFactsHead(dir)
    expect(read).toBeNull()
  })

  it('readFactsHead null si version mismatch', async () => {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(factsHeadPath(dir), JSON.stringify({ version: 99, byRelation: {}, factSetHash: 'x' }))
    expect(await readFactsHead(dir)).toBeNull()
  })
})

describe('computeDelta — ADR-027 Phase 3', () => {
  function makeHead(byRelation: Record<string, string[]>): import('../src/incremental/fact-store.js').FactsHead {
    const allIds = Object.values(byRelation).flat().sort()
    return {
      version: FACT_STORE_VERSION,
      factSetHash: 'hash:' + allIds.join(','),
      generatedAt: 'x',
      byRelation,
    }
  }

  it('added = head - base, removed = base - head', () => {
    const base = makeHead({ NumericLiteralAst: ['a', 'b'] })
    const head = makeHead({ NumericLiteralAst: ['b', 'c'] })
    const delta = computeDelta(base, head)
    expect(delta.added.map((x) => x.id)).toEqual(['c'])
    expect(delta.removed.map((x) => x.id)).toEqual(['a'])
  })

  it('aucune diff → added + removed vides', () => {
    const h = makeHead({ X: ['a', 'b'] })
    const delta = computeDelta(h, h)
    expect(delta.added).toHaveLength(0)
    expect(delta.removed).toHaveLength(0)
  })

  it('relations différentes : delta préserve le mapping relation', () => {
    // En pratique, les fact_ids vivent dans une seule relation (le hash
    // inclut le nom de relation). Test : un id unique à chaque relation
    // → delta liste added/removed avec la relation correcte.
    const base = makeHead({ A: ['xA'], B: ['xB'] })
    const head = makeHead({ A: ['xA'], B: ['yB'] })
    const delta = computeDelta(base, head)
    expect(delta.added).toEqual([{ id: 'yB', relation: 'B' }])
    expect(delta.removed).toEqual([{ id: 'xB', relation: 'B' }])
  })

  it('added/removed triés lex', () => {
    const base = makeHead({ R: ['a'] })
    const head = makeHead({ R: ['x', 'b', 'm'] })
    const delta = computeDelta(base, head)
    const ids = delta.added.map((a) => a.id)
    expect(ids).toEqual([...ids].sort())
  })
})

describe('saveBase + loadBase — ADR-027 Phase 3', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'base-cache-'))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('round-trip save → load', async () => {
    const head = {
      version: FACT_STORE_VERSION,
      factSetHash: 'hash:abc',
      generatedAt: '2026-05-11T00:00:00.000Z',
      byRelation: { R: ['a', 'b'] },
    }
    await saveBase(dir, 'fakeSha123', head)
    const loaded = await loadBase(dir, 'fakeSha123')
    expect(loaded?.factSetHash).toBe('hash:abc')
    expect(loaded?.byRelation.R).toEqual(['a', 'b'])
  })

  it('loadBase null si sha absent', async () => {
    const loaded = await loadBase(dir, 'doesNotExist')
    expect(loaded).toBeNull()
  })

  it('2 bases différentes coexistent (PRs concurrentes)', async () => {
    const h1 = { version: FACT_STORE_VERSION, factSetHash: 'h1', generatedAt: 'x', byRelation: { R: ['a'] } }
    const h2 = { version: FACT_STORE_VERSION, factSetHash: 'h2', generatedAt: 'x', byRelation: { R: ['b'] } }
    await saveBase(dir, 'shaPR1', h1)
    await saveBase(dir, 'shaPR2', h2)
    expect((await loadBase(dir, 'shaPR1'))?.factSetHash).toBe('h1')
    expect((await loadBase(dir, 'shaPR2'))?.factSetHash).toBe('h2')
  })
})
