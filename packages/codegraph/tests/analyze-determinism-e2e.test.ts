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
 * Note flakiness : une divergence intermittente a été observée dans la suite
 * complète (pression mémoire/GC, non reproductible en isolation). En cas
 * d'échec, `captureSnapshotDivergence` dumpe les champs divergents (stderr +
 * artefact) pour identifier la root cause à la prochaine occurrence.
 *
 * Coût : ~5s sur les fixtures (3 runs × ~1.5s analyze).
 */

import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze } from '../src/core/analyzer.js'
import { buildSynopsis } from '../src/synopsis/builder.js'
import type { GraphSnapshot, CodeGraphConfig } from '../src/core/types.js'
import { hashCanonical, captureSnapshotDivergence } from './_determinism-capture.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

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

/**
 * Vérifie la byte-équivalence des 3 runs. Sur divergence, capture le diff
 * (champs concernés) avant d'échouer — pour diagnostiquer une flakiness rare.
 */
async function assertByteEquivalent(label: string, rootDir: string): Promise<void> {
  const snaps = [await runAnalyze(rootDir), await runAnalyze(rootDir), await runAnalyze(rootDir)]
  const stripped = snaps.map(stripVariantFields) as Record<string, unknown>[]
  const [h1, h2, h3] = stripped.map(hashCanonical)
  if (h2 !== h1) captureSnapshotDivergence(`${label}-run2-vs-run1`, stripped[0], stripped[1])
  if (h3 !== h1) captureSnapshotDivergence(`${label}-run3-vs-run1`, stripped[0], stripped[2])
  expect(h2).toBe(h1)
  expect(h3).toBe(h1)
}

describe('analyze determinism E2E (ADR-001 hardening)', () => {
  it('cycles fixture : 3 runs analyze() → byte-équivalent snapshots', { timeout: 30_000 }, async () => {
    await assertByteEquivalent('cycles', path.resolve(__dirname, 'fixtures/cycles'))
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
    await assertByteEquivalent('state-machines', path.resolve(__dirname, 'fixtures/state-machines'))
  })

  it('truth-points fixture : 3 runs analyze() → byte-équivalent', async () => {
    await assertByteEquivalent('truth-points', path.resolve(__dirname, 'fixtures/truth-points'))
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
