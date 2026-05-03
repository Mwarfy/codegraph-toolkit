/**
 * Determinism E2E (ADR-001 hardening) — full pipeline byte-equivalence.
 *
 * Pourquoi ce test existe :
 *   `synopsis-determinism.test.ts` valide UNIQUEMENT `buildSynopsis()`
 *   sur un GraphSnapshot synthétique de 3 fichiers. Il ne couvre PAS
 *   l'analyzer entier (50+ extracteurs, dont certains lisent git history :
 *   co-change, granger-causality, lyapunov-cochange, persistent-cycles).
 *   La promesse "même code → même brief" demande un harness end-to-end.
 *
 * Ce test :
 *   1. Lance `analyze()` 3× sur des fixtures réelles (cycles, state-machines).
 *   2. Hash les outputs structurels (snapshot JSON canoniquement sérialisé,
 *      synopsis multi-niveaux).
 *   3. Exige byte-équivalence stricte entre les 3 runs.
 *
 * Différence vs le test legacy : on appelle le PIPELINE COMPLET
 * (`analyze` → `buildSynopsis`), pas juste la dernière étape pure. Si un
 * extracteur introduit du nondéterminisme (ordre Map traversal, Date.now()
 * dans un detector, etc.), ce test pète — pas le legacy.
 *
 * Coût : ~5s sur les fixtures (3 runs × ~1.5s analyze).
 */

import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze } from '../src/core/analyzer.js'
import { buildSynopsis } from '../src/synopsis/builder.js'
import type { GraphSnapshot, CodeGraphConfig } from '../src/core/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Hash a value via canonical JSON serialization with sorted keys.
 * Avoids false negatives from key ordering variance in Object spread.
 */
function hashValue(value: unknown): string {
  const json = JSON.stringify(value, (_, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {}
      for (const key of Object.keys(v).sort()) sorted[key] = v[key]
      return sorted
    }
    return v
  })
  return createHash('sha256').update(json).digest('hex')
}

/**
 * Strip metadata fields that are EXPECTED to vary between runs (timing,
 * generatedAt). The CONTENT (nodes, edges, stats, detectors output)
 * must be deterministic — that's what we test.
 */
function stripVariantFields(snapshot: GraphSnapshot): Omit<GraphSnapshot, 'generatedAt'> {
  const { generatedAt: _generatedAt, ...rest } = snapshot
  return rest
}

async function runAnalyze(rootDir: string): Promise<GraphSnapshot> {
  const config: CodeGraphConfig = {
    rootDir,
    include: ['**/*.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  }
  const result = await analyze(config, {
    skipPersistenceLoad: true,
    skipPersistenceSave: true,
  })
  return result.snapshot
}

describe('analyze determinism E2E (ADR-001 hardening)', () => {
  it('cycles fixture : 3 runs analyze() → byte-équivalent snapshots', async () => {
    const rootDir = path.resolve(__dirname, 'fixtures/cycles')

    const snap1 = await runAnalyze(rootDir)
    const snap2 = await runAnalyze(rootDir)
    const snap3 = await runAnalyze(rootDir)

    const h1 = hashValue(stripVariantFields(snap1))
    const h2 = hashValue(stripVariantFields(snap2))
    const h3 = hashValue(stripVariantFields(snap3))

    expect(h2).toBe(h1)
    expect(h3).toBe(h1)
  })

  it('cycles fixture : 3 runs synopsis level-1+2+3 → byte-équivalent', async () => {
    const rootDir = path.resolve(__dirname, 'fixtures/cycles')
    const snap = await runAnalyze(rootDir)

    // Build synopsis 3× — pure function, must be deterministic.
    const s1 = JSON.stringify(buildSynopsis(snap))
    const s2 = JSON.stringify(buildSynopsis(snap))
    const s3 = JSON.stringify(buildSynopsis(snap))

    expect(s2).toBe(s1)
    expect(s3).toBe(s1)
  })

  it('state-machines fixture : 3 runs analyze() → byte-équivalent', async () => {
    const rootDir = path.resolve(__dirname, 'fixtures/state-machines')

    const snap1 = await runAnalyze(rootDir)
    const snap2 = await runAnalyze(rootDir)
    const snap3 = await runAnalyze(rootDir)

    const h1 = hashValue(stripVariantFields(snap1))
    const h2 = hashValue(stripVariantFields(snap2))
    const h3 = hashValue(stripVariantFields(snap3))

    expect(h2).toBe(h1)
    expect(h3).toBe(h1)
  })

  it('truth-points fixture : 3 runs analyze() → byte-équivalent', async () => {
    const rootDir = path.resolve(__dirname, 'fixtures/truth-points')

    const snap1 = await runAnalyze(rootDir)
    const snap2 = await runAnalyze(rootDir)
    const snap3 = await runAnalyze(rootDir)

    const h1 = hashValue(stripVariantFields(snap1))
    const h2 = hashValue(stripVariantFields(snap2))
    const h3 = hashValue(stripVariantFields(snap3))

    expect(h2).toBe(h1)
    expect(h3).toBe(h1)
  })

  it('detector array order : sorted lex (no Map insertion order leak)', async () => {
    // Spécifique : si un detector itère sur Map.entries() et émet en ordre
    // d'insertion, ses outputs peuvent différer entre runs même sur même input
    // (rare en V8 mais arrive). On vérifie que les nodes/edges sont sortés.
    const rootDir = path.resolve(__dirname, 'fixtures/cycles')
    const snap = await runAnalyze(rootDir)

    // Nodes sortés par id
    const nodeIds = snap.nodes.map(n => n.id)
    const sortedNodeIds = [...nodeIds].sort()
    expect(nodeIds).toEqual(sortedNodeIds)

    // Edges sortés par (from, to)
    const edgeKeys = snap.edges.map(e => `${e.from}\x00${e.to}\x00${e.type}`)
    const sortedEdgeKeys = [...edgeKeys].sort()
    expect(edgeKeys).toEqual(sortedEdgeKeys)
  })
})
