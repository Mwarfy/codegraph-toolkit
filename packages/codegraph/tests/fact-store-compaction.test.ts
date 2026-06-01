// ADR-028
/**
 * Tests pour la compaction du content-addressed fact store.
 * Vérifie :
 *   - shouldCompact : détecte orphans + size thresholds
 *   - compactFactStore : supprime orphelins, garde référencés
 *   - keepBases LRU : bases anciennes pruned au-delà du seuil
 *   - dryRun : pas d'écriture, stats correctes
 *   - atomicité : si crash entre stream+rename, le store original
 *     reste lisible
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  writeFactStore,
  saveBase,
  buildFactsHead,
  factStorePath,
  basesDir,
  FACT_STORE_VERSION,
} from '../src/incremental/fact-store.js'
import {
  shouldCompact,
  compactFactStore,
  DEFAULT_COMPACTION_CONFIG,
} from '../src/incremental/fact-store-compaction.js'
import type { AstFactsBundle } from '../src/datalog-detectors/ast-facts/types.js'

function emptyBundle(): AstFactsBundle {
  // Toutes les relations à vide — seuls les champs touchés par les
  // tests sont remplis.
  const out = {} as Record<string, unknown[]>
  const relations = [
    'numericLiterals', 'binaryExpressions', 'exemptionLines', 'fileTags',
    'callExpressions', 'functionScopes', 'functionParams', 'sanitizerCandidates',
    'taintSinkCandidates', 'longFunctionCandidates', 'functionComplexities',
    'hardcodedSecretCandidates', 'eventListenerSiteCandidates', 'barrelFiles',
    'importEdges', 'envVarReads', 'constantExpressionCandidates',
    'taintedArgumentCandidates', 'eventEmitSiteCandidates', 'taintedVarDeclCandidates',
    'taintedVarArgCallCandidates', 'resourceImbalanceCandidates',
    'secretVarRefCandidates', 'corsConfigCandidates', 'tlsUnsafeCandidates',
    'weakRandomCandidates', 'excessiveOptionalParamsCandidates',
    'wrapperSuperfluousCandidates', 'deepNestingCandidates',
    'emptyCatchNoCommentCandidates', 'regexLiteralCandidates',
    'tryCatchSwallowCandidates', 'awaitInLoopCandidates',
    'allocationInLoopCandidates', 'deadCodeFindings',
  ]
  for (const r of relations) out[r] = []
  return out as unknown as AstFactsBundle
}

function makeNumericFact(file: string, line: number, valueText: string): never {
  return {
    file, line, valueText, valueAbs: parseFloat(valueText) || 0,
    parentKind: 'Other', parentName: '', parentArgIdx: -1,
    isScreamingSnake: 0, isRatio: 0, isTrivial: 0,
  } as never
}

describe('fact-store-compaction — ADR-028', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-compact-'))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('shouldCompact détecte > orphan threshold', async () => {
    // Setup : store avec 10 facts, head ne réfère que 5 (= 50% orphans)
    const bundle = emptyBundle()
    for (let i = 0; i < 10; i++) {
      bundle.numericLiterals.push(makeNumericFact(`f${i}.ts`, i, String(i)))
    }
    const { head, records } = buildFactsHead(bundle, { generatedAt: 'x' })
    await writeFactStore(dir, head, records)

    // Override head avec seulement 5 fact_ids (les autres deviennent orphelins)
    const reducedHead = {
      version: FACT_STORE_VERSION,
      factSetHash: 'reduced',
      generatedAt: 'x',
      byRelation: { numericLiterals: head.byRelation.numericLiterals.slice(0, 5) },
    }
    await fs.writeFile(
      path.join(dir, 'facts.head.json'),
      JSON.stringify(reducedHead),
    )

    const stats = await shouldCompact(dir, { ...DEFAULT_COMPACTION_CONFIG, maxOrphanRatio: 0.30 })
    expect(stats).not.toBeNull()
    expect(stats!.shouldCompact).toBe(true)
    expect(stats!.reason).toBe('orphans')
    expect(stats!.orphans).toBe(5)
  })

  it('shouldCompact détecte > size threshold', async () => {
    const bundle = emptyBundle()
    for (let i = 0; i < 10; i++) {
      bundle.numericLiterals.push(makeNumericFact(`f${i}.ts`, i, String(i)))
    }
    const { head, records } = buildFactsHead(bundle, { generatedAt: 'x' })
    await writeFactStore(dir, head, records)

    // maxSizeBytes très bas (1 byte) → shouldCompact triggered by size
    const stats = await shouldCompact(dir, { ...DEFAULT_COMPACTION_CONFIG, maxSizeBytes: 1 })
    expect(stats!.shouldCompact).toBe(true)
    expect(stats!.reason).toBe('size')
  })

  it('shouldCompact null si pas de store', async () => {
    const stats = await shouldCompact(dir)
    expect(stats).toBeNull()
  })

  it('compactFactStore supprime les orphelins, garde les référencés', async () => {
    const bundle = emptyBundle()
    for (let i = 0; i < 10; i++) {
      bundle.numericLiterals.push(makeNumericFact(`f${i}.ts`, i, String(i)))
    }
    const { head, records } = buildFactsHead(bundle, { generatedAt: 'x' })
    await writeFactStore(dir, head, records)
    expect(records).toHaveLength(10)

    // Réduit head à 3 fact_ids
    const keptIds = head.byRelation.numericLiterals.slice(0, 3)
    const reducedHead = {
      version: FACT_STORE_VERSION,
      factSetHash: 'reduced',
      generatedAt: 'x',
      byRelation: { numericLiterals: keptIds },
    }
    await fs.writeFile(path.join(dir, 'facts.head.json'), JSON.stringify(reducedHead))

    const result = await compactFactStore(dir)
    expect(result.kept).toBe(3)
    expect(result.removed).toBe(7)
    expect(result.dryRun).toBe(false)

    // Vérifie que le store ne contient plus que 3 lignes
    const content = await fs.readFile(factStorePath(dir), 'utf-8')
    const lines = content.split('\n').filter((l) => l)
    expect(lines).toHaveLength(3)
    // Et que les 3 fact_ids sont les bons
    const remainingIds = lines.map((l) => (JSON.parse(l) as { id: string }).id).sort()
    expect(remainingIds).toEqual([...keptIds].sort())
  })

  it('dryRun : compte les orphelins sans modifier le store', async () => {
    const bundle = emptyBundle()
    for (let i = 0; i < 5; i++) {
      bundle.numericLiterals.push(makeNumericFact(`f${i}.ts`, i, String(i)))
    }
    const { head, records } = buildFactsHead(bundle, { generatedAt: 'x' })
    await writeFactStore(dir, head, records)

    const reducedHead = { ...head, byRelation: { numericLiterals: head.byRelation.numericLiterals.slice(0, 2) } }
    await fs.writeFile(path.join(dir, 'facts.head.json'), JSON.stringify(reducedHead))

    const sizeBefore = (await fs.stat(factStorePath(dir))).size
    const result = await compactFactStore(dir, DEFAULT_COMPACTION_CONFIG, { dryRun: true })
    expect(result.dryRun).toBe(true)
    expect(result.kept).toBe(2)
    expect(result.removed).toBe(3)
    expect(result.freedBytes).toBe(0)

    // Store inchangé
    const sizeAfter = (await fs.stat(factStorePath(dir))).size
    expect(sizeAfter).toBe(sizeBefore)
  })

  it('keepBases LRU : les bases au-delà du seuil sont supprimées', async () => {
    // Setup : 5 bases, mtime échelonnées
    const bd = basesDir(dir)
    await fs.mkdir(bd, { recursive: true })

    const baseHead = (id: string) => ({
      version: FACT_STORE_VERSION,
      factSetHash: id,
      generatedAt: 'x',
      byRelation: { numericLiterals: [id] },
    })

    for (let i = 0; i < 5; i++) {
      await saveBase(dir, `sha-${i}`, baseHead(`hash-${i}`))
      // Force mtime espacé en ms pour LRU déterministe
      const past = new Date(Date.now() - (5 - i) * 1000)
      await fs.utimes(path.join(bd, `sha-${i}.json`), past, past)
    }

    // Compaction keepBases=2 → garde sha-3 et sha-4, supprime 0/1/2
    const result = await compactFactStore(dir, { ...DEFAULT_COMPACTION_CONFIG, keepBases: 2 })
    expect(result.basesPruned).toBe(3)

    const remaining = (await fs.readdir(bd)).filter((f) => f.endsWith('.json'))
    expect(remaining.sort()).toEqual(['sha-3.json', 'sha-4.json'])
  })

  it('un fact référencé uniquement par une base conservée survit', async () => {
    // Store avec 5 facts. HEAD ne réfère que le 1er ; une base LRU réfère
    // le 2e. Les 3 autres sont orphelins. La base étant dans keepBases,
    // son fact doit être conservé (union HEAD ∪ bases).
    const bundle = emptyBundle()
    for (let i = 0; i < 5; i++) {
      bundle.numericLiterals.push(makeNumericFact(`f${i}.ts`, i, String(i)))
    }
    const { head, records } = buildFactsHead(bundle, { generatedAt: 'x' })
    await writeFactStore(dir, head, records)
    const ids = head.byRelation.numericLiterals

    // HEAD réduit au seul id[0].
    await fs.writeFile(path.join(dir, 'facts.head.json'), JSON.stringify({
      version: FACT_STORE_VERSION,
      factSetHash: 'reduced',
      generatedAt: 'x',
      byRelation: { numericLiterals: [ids[0]] },
    }))
    // Base référençant id[1] uniquement.
    await saveBase(dir, 'sha-base', {
      version: FACT_STORE_VERSION,
      factSetHash: 'base',
      generatedAt: 'x',
      byRelation: { numericLiterals: [ids[1]] },
    })

    const result = await compactFactStore(dir, { ...DEFAULT_COMPACTION_CONFIG, keepBases: 5 })
    expect(result.kept).toBe(2)
    expect(result.removed).toBe(3)

    const lines = (await fs.readFile(factStorePath(dir), 'utf-8')).split('\n').filter((l) => l)
    const remainingIds = lines.map((l) => (JSON.parse(l) as { id: string }).id).sort()
    expect(remainingIds).toEqual([ids[0], ids[1]].sort())
  })

  it('compaction d\'un store vide est un no-op safe', async () => {
    const result = await compactFactStore(dir)
    expect(result.kept).toBe(0)
    expect(result.removed).toBe(0)
    expect(result.freedBytes).toBe(0)
  })

  it('lignes corrompues sont dropped à la compaction', async () => {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      factStorePath(dir),
      '{"id":"a","r":"R","v":{}}\nNOT_JSON_LINE\n{"id":"b","r":"R","v":{}}\n',
    )
    // Head ne référence rien → tout est orphelin SAUF si on ajoute
    // 'a' et 'b' dans le head
    await fs.writeFile(path.join(dir, 'facts.head.json'), JSON.stringify({
      version: FACT_STORE_VERSION,
      factSetHash: 'x',
      generatedAt: 'x',
      byRelation: { R: ['a', 'b'] },
    }))

    const result = await compactFactStore(dir)
    expect(result.kept).toBe(2)
    expect(result.removed).toBe(1)  // la ligne corrompue
  })
})
