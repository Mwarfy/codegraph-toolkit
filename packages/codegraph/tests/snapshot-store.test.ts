// ADR-027
/**
 * Tests pour le storage v2 du snapshot (Phase 2 d'ADR-027).
 * Vérifie :
 *   - Round-trip write → read
 *   - Sidecar `snapshot.meta.json` est lu en fast-path
 *   - Backup `.bak` créé à la deuxième écriture
 *   - readStoredSnapshot null sur version mismatch
 *   - listLegacySnapshots détecte les anciens fichiers `snapshot-*.json`
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  writeStoredSnapshot,
  readStoredSnapshot,
  readSnapshotMeta,
  snapshotPath,
  snapshotMetaPath,
  snapshotBackupPath,
  listLegacySnapshots,
  SNAPSHOT_VERSION,
  type SnapshotMeta,
} from '../src/incremental/snapshot-store.js'
import type { GraphSnapshot } from '../src/core/types.js'

function fakePayload(): GraphSnapshot {
  return {
    version: '1',
    generatedAt: '2026-05-10T20:00:00.000Z',
    rootDir: '/fake',
    nodes: [],
    edges: [],
    stats: {
      totalFiles: 0,
      totalEdges: 0,
      orphanCount: 0,
      connectedCount: 0,
      entryPointCount: 0,
      uncertainCount: 0,
      healthScore: 1,
      edgesByType: {},
    } as GraphSnapshot['stats'],
  } as GraphSnapshot
}

function fakeMeta(inputHash: string): SnapshotMeta {
  return {
    version: SNAPSHOT_VERSION,
    inputHash,
    generatedAt: '2026-05-10T20:00:00.000Z',
    fileCount: 0,
  }
}

describe('snapshot-store v2 — ADR-027 Phase 2', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snap-store-'))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('round-trip write → read', async () => {
    const meta = fakeMeta('abc123')
    const payload = fakePayload()
    await writeStoredSnapshot(dir, meta, payload)

    const stored = await readStoredSnapshot(dir)
    expect(stored).not.toBeNull()
    expect(stored!.meta.inputHash).toBe('abc123')
    expect(stored!.payload.rootDir).toBe('/fake')
  })

  it('écrit le sidecar meta en parallèle', async () => {
    const meta = fakeMeta('def456')
    await writeStoredSnapshot(dir, meta, fakePayload())

    const sidecar = await fs.readFile(snapshotMetaPath(dir), 'utf-8')
    const parsed = JSON.parse(sidecar) as SnapshotMeta
    expect(parsed.inputHash).toBe('def456')
  })

  it('readSnapshotMeta utilise le sidecar (fast path)', async () => {
    const meta = fakeMeta('fast123')
    await writeStoredSnapshot(dir, meta, fakePayload())

    const read = await readSnapshotMeta(dir)
    expect(read?.inputHash).toBe('fast123')
  })

  it('readSnapshotMeta fallback sur le payload si sidecar manquant', async () => {
    const meta = fakeMeta('fallback123')
    await writeStoredSnapshot(dir, meta, fakePayload())
    await fs.unlink(snapshotMetaPath(dir))

    const read = await readSnapshotMeta(dir)
    expect(read?.inputHash).toBe('fallback123')
  })

  it('backup .bak créé à la 2e écriture', async () => {
    await writeStoredSnapshot(dir, fakeMeta('first'), fakePayload())
    await writeStoredSnapshot(dir, fakeMeta('second'), fakePayload())

    const bak = await fs.readFile(snapshotBackupPath(dir), 'utf-8')
    const parsed = JSON.parse(bak) as { meta: SnapshotMeta }
    expect(parsed.meta.inputHash).toBe('first')
  })

  it('readStoredSnapshot null si version mismatch', async () => {
    // Écrit un faux fichier avec version=99
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      snapshotPath(dir),
      JSON.stringify({ version: 99, meta: fakeMeta('x'), payload: fakePayload() }),
    )
    const stored = await readStoredSnapshot(dir)
    expect(stored).toBeNull()
  })

  it('readStoredSnapshot null si dossier inexistant', async () => {
    const empty = path.join(dir, 'never-existed')
    const stored = await readStoredSnapshot(empty)
    expect(stored).toBeNull()
  })

  it('listLegacySnapshots détecte les fichiers Phase 1', async () => {
    await fs.writeFile(
      path.join(dir, 'snapshot-2026-05-10T20-40-10-abc1234.json'),
      '{}',
    )
    await fs.writeFile(
      path.join(dir, 'snapshot-2026-05-09T15-00-00-def5678.json'),
      '{}',
    )
    // Distractor — must be ignored
    await fs.writeFile(path.join(dir, 'snapshot.json'), '{}')
    await fs.writeFile(path.join(dir, 'synopsis.json'), '{}')

    const legacy = await listLegacySnapshots(dir)
    expect(legacy).toHaveLength(2)
    // Newest first
    expect(legacy[0]).toContain('2026-05-10T20-40-10-abc1234')
    expect(legacy[1]).toContain('2026-05-09T15-00-00-def5678')
  })
})
