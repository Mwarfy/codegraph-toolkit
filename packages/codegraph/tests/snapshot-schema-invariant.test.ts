// ADR-030
/**
 * Garde-fou de la frontière publique `snapshot.json` (ADR-030).
 *
 * ADR-006 (supersédée) gelait `core/types.ts` au niveau fichier — règle
 * "modifications conservatrices uniquement". Cette approche bloquait
 * l'évolution interne légitime (e.g. découpage `GraphSnapshot` en
 * sub-snapshots).
 *
 * ADR-030 reformule : le contrat externe est le JSON sérialisé,
 * pas le fichier TS. Le code interne est libre tant que la shape
 * sérialisée reste stable.
 *
 * Ce test EST le garde-fou structurel. Il assertionne explicitement
 * les champs requis et types du `snapshot.json` produit. Toute
 * modification incompatible doit soit bumper `meta.version`, soit
 * faire péter ce test au CI.
 *
 * Couvre :
 *   - Wrapper v2 : `version` + `meta` + `payload`
 *   - SnapshotMeta : `inputHash`, `generatedAt`, etc.
 *   - GraphSnapshot top-level : `version`, `nodes`, `edges`, `stats`, `rootDir`
 *   - GraphNode shape (champs requis)
 *   - GraphEdge shape (champs requis)
 *   - GraphStats shape (champs requis)
 *
 * Ne couvre PAS (volontairement) :
 *   - Les détecteurs optionnels (envUsage, cycles, etc.) — peuvent
 *     être absents selon config. Si on veut un consumer qui les
 *     consomme, c'est un sous-contrat séparé à tester.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze } from '../src/core/analyzer.js'
import {
  writeStoredSnapshot,
  type SnapshotMeta,
  SNAPSHOT_VERSION,
} from '../src/incremental/snapshot-store.js'
import { computeInputHash } from '../src/incremental/input-hash.js'
import type { CodeGraphConfig } from '../src/core/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures/cycles')

let snapshotDir: string
let serializedV2: { version: number; meta: SnapshotMeta; payload: unknown }

beforeAll(async () => {
  // Analyse une fixture connue + sérialise via le pipeline v2 standard.
  // Le test consomme le JSON parsed, simulant un consumer externe qui
  // re-lit le fichier (e.g. Sentinel, codegraph-mcp, hook bash).
  snapshotDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schema-invariant-'))
  const config: CodeGraphConfig = {
    rootDir: FIXTURE_DIR,
    include: ['**/*.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    entryPoints: [],
    detectors: [],
    snapshotDir,
    maxSnapshots: 50,
  }
  const result = await analyze(config, {
    skipPersistenceLoad: true,
    skipPersistenceSave: true,
  })
  const { hash, ctx } = await computeInputHash(config, result.files)
  const meta: SnapshotMeta = {
    version: SNAPSHOT_VERSION,
    inputHash: hash,
    generatedAt: result.snapshot.generatedAt,
    baseSha: result.snapshot.commitHash,
    fileCount: ctx.fileCount,
    toolingVersion: ctx.toolingVersion,
  }
  await writeStoredSnapshot(snapshotDir, meta, result.snapshot)
  const raw = await fs.readFile(path.join(snapshotDir, 'snapshot.json'), 'utf-8')
  serializedV2 = JSON.parse(raw)
})

afterAll(async () => {
  if (snapshotDir) await fs.rm(snapshotDir, { recursive: true, force: true })
})

describe('snapshot.json schema invariant — ADR-030', () => {
  // ─── V2 wrapper ──────────────────────────────────────────────────────────
  it('wrapper v2 : top-level fields { version, meta, payload }', () => {
    expect(serializedV2).toMatchObject({
      version: expect.any(Number),
      meta: expect.any(Object),
      payload: expect.any(Object),
    })
    expect(serializedV2.version).toBe(SNAPSHOT_VERSION)
  })

  it('meta : champs requis avec bons types', () => {
    const m = serializedV2.meta
    expect(typeof m.version).toBe('number')
    expect(typeof m.inputHash).toBe('string')
    expect(m.inputHash).toMatch(/^[a-f0-9]{64}$/)
    expect(typeof m.generatedAt).toBe('string')
    // baseSha, fileCount, toolingVersion, factSetHash sont optionnels —
    // si présents, leur type doit être conforme.
    if (m.baseSha !== undefined) expect(typeof m.baseSha).toBe('string')
    if (m.fileCount !== undefined) expect(typeof m.fileCount).toBe('number')
    if (m.toolingVersion !== undefined) expect(typeof m.toolingVersion).toBe('string')
    if (m.factSetHash !== undefined) expect(typeof m.factSetHash).toBe('string')
  })

  // ─── GraphSnapshot payload — champs requis ───────────────────────────────
  it('payload : champs racine requis présents', () => {
    const p = serializedV2.payload as Record<string, unknown>
    expect(p).toHaveProperty('version')
    expect(p).toHaveProperty('generatedAt')
    expect(p).toHaveProperty('rootDir')
    expect(p).toHaveProperty('nodes')
    expect(p).toHaveProperty('edges')
    expect(p).toHaveProperty('stats')
  })

  it('payload.version : valeur littérale "1" (schema interne legacy)', () => {
    const p = serializedV2.payload as { version: string }
    expect(p.version).toBe('1')
  })

  it('payload.nodes : array d\'objets', () => {
    const p = serializedV2.payload as { nodes: unknown }
    expect(Array.isArray(p.nodes)).toBe(true)
    expect((p.nodes as unknown[]).length).toBeGreaterThan(0)
  })

  it('payload.edges : array d\'objets', () => {
    const p = serializedV2.payload as { edges: unknown }
    expect(Array.isArray(p.edges)).toBe(true)
  })

  // ─── GraphNode shape ─────────────────────────────────────────────────────
  it('chaque node : champs requis (id, label, type, status, tags) + types corrects', () => {
    const p = serializedV2.payload as { nodes: Array<Record<string, unknown>> }
    for (const n of p.nodes) {
      expect(typeof n.id).toBe('string')
      expect(typeof n.label).toBe('string')
      expect(typeof n.type).toBe('string')
      expect(['file', 'directory']).toContain(n.type)
      expect(typeof n.status).toBe('string')
      expect(['connected', 'orphan', 'entry-point', 'uncertain']).toContain(n.status)
      expect(Array.isArray(n.tags)).toBe(true)
    }
  })

  // ─── GraphEdge shape ─────────────────────────────────────────────────────
  it('chaque edge : champs requis (id, from, to, type, resolved) + types corrects', () => {
    const p = serializedV2.payload as { edges: Array<Record<string, unknown>> }
    for (const e of p.edges) {
      expect(typeof e.id).toBe('string')
      expect(typeof e.from).toBe('string')
      expect(typeof e.to).toBe('string')
      expect(typeof e.type).toBe('string')
      expect(typeof e.resolved).toBe('boolean')
    }
  })

  // ─── GraphStats shape ────────────────────────────────────────────────────
  it('stats : champs requis (totalFiles, totalEdges, healthScore, edgesByType) + types corrects', () => {
    const p = serializedV2.payload as { stats: Record<string, unknown> }
    const s = p.stats
    expect(typeof s.totalFiles).toBe('number')
    expect(typeof s.totalEdges).toBe('number')
    expect(typeof s.orphanCount).toBe('number')
    expect(typeof s.connectedCount).toBe('number')
    expect(typeof s.entryPointCount).toBe('number')
    expect(typeof s.uncertainCount).toBe('number')
    expect(typeof s.healthScore).toBe('number')
    expect(s.healthScore as number).toBeGreaterThanOrEqual(0)
    expect(s.healthScore as number).toBeLessThanOrEqual(1)
    expect(typeof s.edgesByType).toBe('object')
  })

  // ─── Détecteurs optionnels : si présents, types corrects ─────────────────
  it('détecteurs optionnels : forme correcte quand présents', () => {
    const p = serializedV2.payload as Record<string, unknown>
    // Si cycles présent, c'est un array. Validation similaire pour
    // les autres détecteurs optionnels — on liste les plus consommés.
    if (p.cycles !== undefined) expect(Array.isArray(p.cycles)).toBe(true)
    if (p.envUsage !== undefined) expect(Array.isArray(p.envUsage)).toBe(true)
    if (p.truthPoints !== undefined) expect(Array.isArray(p.truthPoints)).toBe(true)
    if (p.barrels !== undefined) expect(Array.isArray(p.barrels)).toBe(true)
    if (p.eventEmitSites !== undefined) expect(Array.isArray(p.eventEmitSites)).toBe(true)
    if (p.symbolRefs !== undefined) expect(Array.isArray(p.symbolRefs)).toBe(true)
  })

  // ─── Round-trip : JSON.parse(JSON.stringify(snap)) → équivalent ──────────
  it('sérialisation idempotente (= ce qu\'un consumer relit est ce qu\'on écrit)', () => {
    const reSerialized = JSON.parse(JSON.stringify(serializedV2))
    expect(reSerialized).toEqual(serializedV2)
  })
})
