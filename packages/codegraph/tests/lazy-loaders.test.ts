// ADR-033
/**
 * Tests Phase 2 ADR-033 — loaders lazy par sous-domaine.
 *
 * Garantit :
 *  - parité stricte entre les loaders lazy et l'extraction depuis le fat
 *    blob (= les sub-files restituent exactement ce que le fat blob
 *    contient)
 *  - fallback v2 transparent (= snapshot sans sub-files → loaders
 *    tombent sur le fat blob, sans crash)
 *  - typing TS correct (loadDetectorOutput typé sur DetectorFieldName)
 *
 * Le test couvre les deux kinds de sub-files :
 *  - Array NDJSON (1 fact / ligne) — la majorité (34 fields)
 *  - Bundle objet (1 ligne JSON unique) — 7 fields : testCoverage,
 *    sqlSchema, codeQualityPatterns, securityPatterns, deprecatedUsage,
 *    argumentsFacts, taintedVars
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze } from '../src/core/analyzer.js'
import {
  writeStoredSnapshot,
  snapshotDetectorsDir,
  snapshotMetricsPath,
  snapshotDetectorPath,
  type SnapshotMeta,
  SNAPSHOT_VERSION,
} from '../src/incremental/snapshot-store.js'
import {
  loadSnapshotPayload,
  loadGraphCore,
  loadDetectorOutput,
  loadMetrics,
  pickGraphCore,
  pickMetrics,
} from '../src/incremental/snapshot-loader.js'
import { computeInputHash } from '../src/incremental/input-hash.js'
import {
  DETECTOR_FIELDS,
  DETECTOR_FIELD_KINDS,
  METRIC_FIELDS,
} from '../src/incremental/snapshot-fields.js'
import type { CodeGraphConfig, GraphSnapshot } from '../src/core/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures/cycles')

let snapshotDir: string
let snapshot: GraphSnapshot

beforeAll(async () => {
  snapshotDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lazy-loaders-'))
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

describe('loadGraphCore — Phase 2 ADR-033', () => {
  it('retourne null si snapshotDir vide', async () => {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lazy-empty-'))
    try {
      const core = await loadGraphCore(emptyDir)
      expect(core).toBeNull()
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true })
    }
  })

  it('extrait les 10 champs GraphCore depuis le fat blob', async () => {
    const core = await loadGraphCore(snapshotDir)
    expect(core).not.toBeNull()
    expect(core!.nodes).toEqual(snapshot.nodes)
    expect(core!.edges).toEqual(snapshot.edges)
    expect(core!.stats).toEqual(snapshot.stats)
    expect(core!.version).toBe(snapshot.version)
    expect(core!.generatedAt).toBe(snapshot.generatedAt)
    expect(core!.rootDir).toBe(snapshot.rootDir)
  })

  it('le résultat ne contient AUCUN champ detector ou metric (séparation propre)', async () => {
    const core = await loadGraphCore(snapshotDir)
    expect(core).not.toBeNull()
    const coreKeys = Object.keys(core!)
    // Champs detector et metric NE doivent PAS apparaître
    for (const detectorField of DETECTOR_FIELDS) {
      expect(coreKeys, `detector field "${detectorField}" leaked in GraphCore`).not.toContain(detectorField)
    }
    for (const metricField of METRIC_FIELDS) {
      expect(coreKeys, `metric field "${metricField}" leaked in GraphCore`).not.toContain(metricField)
    }
  })

  it('pickGraphCore est pure et équivalente à loadGraphCore', async () => {
    const fromLoader = await loadGraphCore(snapshotDir)
    const fromPick = pickGraphCore(snapshot)
    expect(fromLoader).toEqual(fromPick)
  })
})

describe('loadDetectorOutput — Phase 2 ADR-033', () => {
  it('retourne undefined si le snapshot n\'existe pas', async () => {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lazy-no-snap-'))
    try {
      const out = await loadDetectorOutput(emptyDir, 'cycles')
      expect(out).toBeUndefined()
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true })
    }
  })

  it('parité fat blob ↔ sub-file pour TOUS les detector fields présents', async () => {
    for (const field of DETECTOR_FIELDS) {
      const expected = (snapshot as Record<string, unknown>)[field]
      const actual = await loadDetectorOutput(snapshotDir, field)
      expect(actual, `mismatch for detector field "${field}"`).toEqual(expected)
    }
  })

  it('priorise le sub-file plutôt que le fat blob (vérifié par mutation)', async () => {
    // Pour prouver que le loader lit le sub-file et pas le fat blob,
    // on mute le sub-file avec une valeur connue puis on vérifie qu'on
    // récupère la mutation (= preuve que le sub-file est la source).
    const arrayField = DETECTOR_FIELDS.find((f) => {
      const v = (snapshot as Record<string, unknown>)[f]
      return DETECTOR_FIELD_KINDS[f] === 'array' && Array.isArray(v) && (v as unknown[]).length > 0
    })
    if (!arrayField) return  // pas de champ array non-vide sur cette fixture

    const sentinel = { __sentinel__: true, fakeMutation: 42 }
    const subFile = snapshotDetectorPath(snapshotDir, arrayField)
    const original = await fs.readFile(subFile, 'utf-8')
    try {
      await fs.writeFile(subFile, JSON.stringify(sentinel) + '\n', 'utf-8')
      const out = await loadDetectorOutput(snapshotDir, arrayField)
      expect(out).toEqual([sentinel])
    } finally {
      await fs.writeFile(subFile, original, 'utf-8')
    }
  })

  it('parse correctement un sub-file Array vide (= 0 ligne)', async () => {
    // cycles est vide sur la fixture (zéro cycle import)
    const emptyArrayField = DETECTOR_FIELDS.find((f) => {
      const v = (snapshot as Record<string, unknown>)[f]
      return DETECTOR_FIELD_KINDS[f] === 'array' && Array.isArray(v) && (v as unknown[]).length === 0
    })
    if (!emptyArrayField) return  // si aucun champ vide, skip
    const out = await loadDetectorOutput(snapshotDir, emptyArrayField)
    expect(out).toEqual([])
  })

  it('parse correctement un sub-file bundle objet (1 ligne JSON)', async () => {
    const bundleField = DETECTOR_FIELDS.find((f) => {
      const v = (snapshot as Record<string, unknown>)[f]
      return DETECTOR_FIELD_KINDS[f] === 'bundle' && v !== undefined
    })
    if (!bundleField) return
    const out = await loadDetectorOutput(snapshotDir, bundleField)
    expect(out).toEqual((snapshot as Record<string, unknown>)[bundleField])
  })

  it('fallback fat blob si sub-file absent (= snapshot v2 simulé)', async () => {
    // On clone le snapshotDir mais on supprime le sous-dossier
    // snapshot.detectors/ → le loader doit tomber sur le fat blob.
    const v2Dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lazy-v2-'))
    try {
      await fs.copyFile(
        path.join(snapshotDir, 'snapshot.json'),
        path.join(v2Dir, 'snapshot.json'),
      )
      // PAS de snapshot.detectors/ — simule v2 legacy
      const arrayField = DETECTOR_FIELDS.find((f) => {
        const v = (snapshot as Record<string, unknown>)[f]
        return Array.isArray(v) && (v as unknown[]).length > 0
      })
      if (!arrayField) return
      const out = await loadDetectorOutput(v2Dir, arrayField)
      expect(out).toEqual((snapshot as Record<string, unknown>)[arrayField])
    } finally {
      await fs.rm(v2Dir, { recursive: true, force: true })
    }
  })
})

describe('loadMetrics — Phase 2 ADR-033', () => {
  it('retourne {} si le snapshot n\'existe pas', async () => {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lazy-metrics-empty-'))
    try {
      const m = await loadMetrics(emptyDir)
      expect(m).toEqual({})
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true })
    }
  })

  it('parité fat blob ↔ snapshot.metrics.json', async () => {
    const fromLoader = await loadMetrics(snapshotDir)
    const fromPick = pickMetrics(snapshot)
    expect(fromLoader).toEqual(fromPick)
  })

  it('priorise snapshot.metrics.json plutôt que le fat blob (vérifié par mutation)', async () => {
    const sentinel = { __sentinel__: true, modularityScore: { fake: 1 } }
    const metricsFile = snapshotMetricsPath(snapshotDir)
    const original = await fs.readFile(metricsFile, 'utf-8')
    try {
      await fs.writeFile(metricsFile, JSON.stringify(sentinel) + '\n', 'utf-8')
      const m = await loadMetrics(snapshotDir)
      expect(m).toEqual(sentinel)
    } finally {
      await fs.writeFile(metricsFile, original, 'utf-8')
    }
  })

  it('fallback fat blob si snapshot.metrics.json absent (= snapshot v2 simulé)', async () => {
    const v2Dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lazy-metrics-v2-'))
    try {
      await fs.copyFile(
        path.join(snapshotDir, 'snapshot.json'),
        path.join(v2Dir, 'snapshot.json'),
      )
      // PAS de snapshot.metrics.json
      const m = await loadMetrics(v2Dir)
      expect(m).toEqual(pickMetrics(snapshot))
    } finally {
      await fs.rm(v2Dir, { recursive: true, force: true })
    }
  })

  it('pickMetrics omet les champs undefined (pas de noisy null)', () => {
    const bare: GraphSnapshot = {
      version: '1',
      generatedAt: '2026-01-01T00:00:00Z',
      rootDir: '/x',
      nodes: [],
      edges: [],
      stats: {
        totalFiles: 0, totalEdges: 0, orphanCount: 0, connectedCount: 0,
        entryPointCount: 0, uncertainCount: 0, healthScore: 1,
        edgesByType: { import: 0, event: 0, route: 0, queue: 0, 'dynamic-load': 0, 'db-table': 0 },
      },
    }
    const m = pickMetrics(bare)
    expect(m).toEqual({})  // tous undefined → {} (pas {moduleMetrics: undefined, ...})
  })
})

describe('Phase 2 ADR-033 — invariant complet loader vs fat blob', () => {
  it('reconstruire snapshot via les 3 loaders = strictement identique au fat blob', async () => {
    // C'est le « bit-identical loader vs fat blob » du critère
    // d'acceptance ADR-033.
    const core = await loadGraphCore(snapshotDir)
    const metrics = await loadMetrics(snapshotDir)
    const detectors: Record<string, unknown> = {}
    for (const field of DETECTOR_FIELDS) {
      const value = await loadDetectorOutput(snapshotDir, field)
      if (value !== undefined) {
        detectors[field] = value
      }
    }
    const reconstructed = { ...core, ...detectors, ...metrics }
    // Compare aux clés présentes dans le fat blob (= ignore les
    // champs undefined du snapshot).
    const fatBlobNonUndefined: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(snapshot)) {
      if (v !== undefined) fatBlobNonUndefined[k] = v
    }
    expect(reconstructed).toEqual(fatBlobNonUndefined)
  })
})
