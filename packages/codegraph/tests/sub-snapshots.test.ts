// ADR-033
/**
 * Tests Phase 1 ADR-033 — écriture parallèle des sub-snapshots.
 *
 * Vérifie que `writeStoredSnapshot` :
 *  - écrit toujours le fat blob `snapshot.json` (back-compat absolue)
 *  - écrit en parallèle un fichier par champ `DetectorOutputs` présent
 *    dans `snapshot.detectors/<field>.ndjson`
 *  - écrit `snapshot.metrics.json` avec l'union des champs `SnapshotMetrics`
 *  - les sub-files restituent exactement le contenu du fat blob (parité)
 *
 * Plus : exhaustivité des const arrays `DETECTOR_FIELDS` / `METRIC_FIELDS`
 * face à `keyof DetectorOutputs` / `keyof SnapshotMetrics`. La garantie
 * existe déjà au type-level dans `snapshot-fields.ts` (assertion `never`),
 * ce test runtime double le filet pour rendre l'erreur lisible au CI si
 * quelqu'un retire un champ et casse la cohérence.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze } from '../src/core/analyzer.js'
import {
  writeStoredSnapshot,
  readStoredSnapshot,
  snapshotDetectorsDir,
  snapshotDetectorPath,
  snapshotMetricsPath,
  type SnapshotMeta,
  SNAPSHOT_VERSION,
  SUPPORTED_SNAPSHOT_VERSIONS,
} from '../src/incremental/snapshot-store.js'
import { computeInputHash } from '../src/incremental/input-hash.js'
import { DETECTOR_FIELDS, METRIC_FIELDS } from '../src/incremental/snapshot-fields.js'
import type {
  CodeGraphConfig,
  DetectorOutputs,
  GraphSnapshot,
  SnapshotMetrics,
} from '../src/core/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures/cycles')

let snapshotDir: string
let snapshot: GraphSnapshot

beforeAll(async () => {
  snapshotDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sub-snapshots-'))
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
  snapshot = result.snapshot
})

afterAll(async () => {
  if (snapshotDir) await fs.rm(snapshotDir, { recursive: true, force: true })
})

describe('snapshot-fields — exhaustivité runtime des const arrays', () => {
  // L'exhaustivité est déjà garantie au type-level dans snapshot-fields.ts
  // (Exclude<keyof X, FieldName> extends never). Ce test runtime double
  // le filet pour visibilité au CI : si quelqu'un ajoute un champ à
  // DetectorOutputs ou SnapshotMetrics et oublie de l'enregistrer dans la
  // const array, c'est ici qu'on le voit avant qu'il manque dans les
  // sub-snapshots écrits.

  it('DETECTOR_FIELDS contains every key of DetectorOutputs found in the payload', () => {
    // payload = un GraphSnapshot réel ; ses keys sont toutes des keys de
    // DetectorOutputs | GraphCore | SnapshotMetrics. On filtre les champs
    // présents qui correspondent à DetectorOutputs via la const array
    // elle-même : si un champ est absent de DETECTOR_FIELDS mais présent
    // dans le payload ET pas dans GraphCore/SnapshotMetrics, on a un
    // missing.
    const detectorSet = new Set<string>(DETECTOR_FIELDS as readonly string[])
    const metricSet = new Set<string>(METRIC_FIELDS as readonly string[])
    const graphCoreKeys = new Set<string>([
      'version', 'generatedAt', 'commitHash', 'commitMessage', 'rootDir',
      'nodes', 'edges', 'stats', 'symbolRefs', 'typedCalls',
    ])
    const orphanKeys = Object.keys(snapshot).filter((k) =>
      !graphCoreKeys.has(k) && !metricSet.has(k) && !detectorSet.has(k),
    )
    expect(orphanKeys, 'orphan fields in snapshot (not core, not detector, not metric)').toEqual([])
  })

  it('every DETECTOR_FIELDS entry typecheck-matches keyof DetectorOutputs at compile time', () => {
    // Compile-time guarantee via `satisfies readonly (keyof DetectorOutputs)[]`
    // in snapshot-fields.ts. Runtime assertion : array is non-empty (sanity).
    expect(DETECTOR_FIELDS.length).toBeGreaterThan(0)
    const _typeCheck: readonly (keyof DetectorOutputs)[] = DETECTOR_FIELDS
    expect(_typeCheck).toBe(DETECTOR_FIELDS)
  })

  it('every METRIC_FIELDS entry typecheck-matches keyof SnapshotMetrics at compile time', () => {
    expect(METRIC_FIELDS.length).toBeGreaterThan(0)
    const _typeCheck: readonly (keyof SnapshotMetrics)[] = METRIC_FIELDS
    expect(_typeCheck).toBe(METRIC_FIELDS)
  })
})

describe('writeStoredSnapshot — sub-snapshots ADR-033 Phase 1', () => {
  it('SNAPSHOT_VERSION bumpé à 3', () => {
    expect(SNAPSHOT_VERSION).toBe(3)
  })

  it('SUPPORTED_SNAPSHOT_VERSIONS accepte v2 et v3 (migration douce)', () => {
    expect(SUPPORTED_SNAPSHOT_VERSIONS).toContain(2)
    expect(SUPPORTED_SNAPSHOT_VERSIONS).toContain(3)
  })

  it('fat blob snapshot.json reste écrit (back-compat absolue)', async () => {
    const fat = await readStoredSnapshot(snapshotDir)
    expect(fat).not.toBeNull()
    expect(fat!.meta.version).toBe(3)
    expect(fat!.payload.nodes.length).toBeGreaterThan(0)
  })

  it('snapshot.detectors/ existe après writeStoredSnapshot', async () => {
    const dir = snapshotDetectorsDir(snapshotDir)
    const stat = await fs.stat(dir)
    expect(stat.isDirectory()).toBe(true)
  })

  it('snapshot.metrics.json existe après writeStoredSnapshot', async () => {
    const file = snapshotMetricsPath(snapshotDir)
    const stat = await fs.stat(file)
    expect(stat.isFile()).toBe(true)
  })

  it('chaque champ DetectorOutputs présent dans le payload a son sub-file', async () => {
    for (const field of DETECTOR_FIELDS) {
      const value = (snapshot as Record<string, unknown>)[field]
      if (value === undefined) continue

      const subFile = snapshotDetectorPath(snapshotDir, field)
      const stat = await fs.stat(subFile).catch(() => null)
      expect(stat?.isFile(), `sub-file missing for detector "${field}"`).toBe(true)
    }
  })

  it('sub-file NDJSON Array : chaque ligne est un JSON parsable matching le payload', async () => {
    // On choisit un champ Array typique (eventEmitSites est généralement
    // peuplé sur la fixture cycles). Si pas peuplé, fallback sur le
    // premier champ Array non vide trouvé.
    const arrayField = DETECTOR_FIELDS.find((f) => {
      const v = (snapshot as Record<string, unknown>)[f]
      return Array.isArray(v) && (v as unknown[]).length > 0
    })
    if (!arrayField) {
      // Aucun champ Array non-vide sur cette fixture — skip sans échec.
      // Le test "présence" couvre déjà le cas par défaut.
      return
    }
    const subFile = snapshotDetectorPath(snapshotDir, arrayField)
    const content = await fs.readFile(subFile, 'utf-8')
    const lines = content.split('\n').filter((l) => l.length > 0)
    const expected = (snapshot as Record<string, unknown[]>)[arrayField]
    expect(lines.length).toBe(expected.length)
    // Parité strict : chaque ligne JSON.parse → element correspondant
    for (let i = 0; i < lines.length; i++) {
      const parsed = JSON.parse(lines[i])
      expect(parsed).toEqual(expected[i])
    }
  })

  it('sub-file NDJSON bundle objet : 1 ligne JSON unique matching le payload', async () => {
    // codeQualityPatterns / securityPatterns / sqlSchema / testCoverage
    // sont des bundles objet (pas array). On cherche un présent.
    const bundleField = DETECTOR_FIELDS.find((f) => {
      const v = (snapshot as Record<string, unknown>)[f]
      return v !== undefined && !Array.isArray(v) && typeof v === 'object'
    })
    if (!bundleField) return
    const subFile = snapshotDetectorPath(snapshotDir, bundleField)
    const content = await fs.readFile(subFile, 'utf-8')
    const lines = content.split('\n').filter((l) => l.length > 0)
    expect(lines.length).toBe(1)
    expect(JSON.parse(lines[0])).toEqual(
      (snapshot as Record<string, unknown>)[bundleField],
    )
  })

  it('snapshot.metrics.json contient les champs SnapshotMetrics non-undefined du payload', async () => {
    const content = await fs.readFile(snapshotMetricsPath(snapshotDir), 'utf-8')
    const parsed = JSON.parse(content) as Record<string, unknown>
    for (const field of METRIC_FIELDS) {
      const expected = (snapshot as Record<string, unknown>)[field]
      if (expected === undefined) {
        expect(parsed).not.toHaveProperty(field)
      } else {
        expect(parsed[field]).toEqual(expected)
      }
    }
  })

  it('snapshot.metrics.json est valide JSON même si tous les champs sont absents', async () => {
    // Edge case : payload sans aucune metric → fichier `{}` valide.
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sub-snapshots-empty-'))
    try {
      const bareSnapshot: GraphSnapshot = {
        version: '1',
        generatedAt: new Date().toISOString(),
        rootDir: FIXTURE_DIR,
        nodes: [],
        edges: [],
        stats: {
          totalFiles: 0, totalEdges: 0, orphanCount: 0, connectedCount: 0,
          entryPointCount: 0, uncertainCount: 0, healthScore: 1,
          edgesByType: { import: 0, event: 0, route: 0, queue: 0, 'dynamic-load': 0, 'db-table': 0 },
        },
      }
      const meta: SnapshotMeta = {
        version: SNAPSHOT_VERSION,
        inputHash: 'a'.repeat(64),
        generatedAt: bareSnapshot.generatedAt,
      }
      await writeStoredSnapshot(emptyDir, meta, bareSnapshot)
      const content = await fs.readFile(snapshotMetricsPath(emptyDir), 'utf-8')
      expect(JSON.parse(content)).toEqual({})
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true })
    }
  })

  it('migration douce : snapshot v2 reste lisible par readStoredSnapshot', async () => {
    // Écrit manuellement un fichier au format v2 (sans sub-files) puis
    // vérifie que readStoredSnapshot le récupère.
    const v2Dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sub-snapshots-v2-'))
    try {
      const bareSnapshot: GraphSnapshot = {
        version: '1',
        generatedAt: new Date().toISOString(),
        rootDir: FIXTURE_DIR,
        nodes: [],
        edges: [],
        stats: {
          totalFiles: 0, totalEdges: 0, orphanCount: 0, connectedCount: 0,
          entryPointCount: 0, uncertainCount: 0, healthScore: 1,
          edgesByType: { import: 0, event: 0, route: 0, queue: 0, 'dynamic-load': 0, 'db-table': 0 },
        },
      }
      const v2Wrapper = {
        version: 2,
        meta: {
          version: 2,
          inputHash: 'b'.repeat(64),
          generatedAt: bareSnapshot.generatedAt,
        },
        payload: bareSnapshot,
      }
      await fs.writeFile(
        path.join(v2Dir, 'snapshot.json'),
        JSON.stringify(v2Wrapper),
        'utf-8',
      )
      const restored = await readStoredSnapshot(v2Dir)
      expect(restored).not.toBeNull()
      expect(restored!.meta.version).toBe(2)
    } finally {
      await fs.rm(v2Dir, { recursive: true, force: true })
    }
  })
})
