// ADR-027
/**
 * Tests e2e pour la Phase 2 d'ADR-027 :
 *   1. `analyze` écrit `snapshot.json` v2 + sidecar meta
 *   2. `loadSnapshot` privilégie v2, fallback legacy avec warning
 *   3. `pruneLegacySnapshots` supprime progressivement les vieux fichiers
 *   4. Round-trip e2e : analyze → read via loadSnapshot → payload identique
 *   5. Perf : `refresh --check` fresh < 1s (target Phase 2 : warm <200ms,
 *      mais cross-process avec discoverFiles on est plutôt 500-800ms)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { analyze } from '../src/core/analyzer.js'
import { computeInputHash } from '../src/incremental/input-hash.js'
import {
  writeStoredSnapshot,
  readSnapshotMeta,
  readStoredSnapshot,
  snapshotPath,
  SNAPSHOT_VERSION,
  type SnapshotMeta,
} from '../src/incremental/snapshot-store.js'
import { pruneLegacySnapshots } from '../src/cli/_shared.js'
import type { CodeGraphConfig } from '../src/core/types.js'

async function makeFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snap-v2-'))
  await fs.mkdir(path.join(dir, 'src'))
  await fs.writeFile(path.join(dir, 'src/a.ts'), 'export const a = 1\n')
  await fs.writeFile(
    path.join(dir, 'src/b.ts'),
    "import { a } from './a.js'\nexport const b = a + 1\n",
  )
  return dir
}

function configFor(rootDir: string): CodeGraphConfig {
  return {
    rootDir,
    include: ['**/*.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    entryPoints: [],
    detectors: [],
    snapshotDir: path.join(rootDir, '.codegraph'),
    maxSnapshots: 50,
  }
}

describe('ADR-027 Phase 2 — analyze writes v2 + legacy migration', () => {
  let dir: string

  beforeEach(async () => {
    dir = await makeFixture()
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('analyze + writeStoredSnapshot round-trip via readStoredSnapshot', async () => {
    const config = configFor(dir)
    const { snapshot, files } = await analyze(config, {
      skipPersistenceLoad: true,
      skipPersistenceSave: true,
    })
    const { hash } = await computeInputHash(config, files)
    const meta: SnapshotMeta = {
      version: SNAPSHOT_VERSION,
      inputHash: hash,
      generatedAt: snapshot.generatedAt,
      fileCount: files.length,
    }
    await writeStoredSnapshot(config.snapshotDir, meta, snapshot)

    const stored = await readStoredSnapshot(config.snapshotDir)
    expect(stored).not.toBeNull()
    expect(stored!.meta.inputHash).toBe(hash)
    expect(stored!.payload.nodes.length).toBe(snapshot.nodes.length)
  })

  it('déterminisme : 2 analyze + computeInputHash → même inputHash', async () => {
    const config = configFor(dir)
    const r1 = await analyze(config, {
      skipPersistenceLoad: true,
      skipPersistenceSave: true,
    })
    const r2 = await analyze(config, {
      skipPersistenceLoad: true,
      skipPersistenceSave: true,
    })
    const h1 = await computeInputHash(config, r1.files)
    const h2 = await computeInputHash(config, r2.files)
    expect(h2.hash).toBe(h1.hash)
  })

  it('pruneLegacySnapshots garde N=2 plus récents, supprime le reste', async () => {
    const snapDir = configFor(dir).snapshotDir
    await fs.mkdir(snapDir, { recursive: true })
    const stamps = [
      '2026-05-10T20-40-10-aaa1111',
      '2026-05-09T20-40-10-bbb2222',
      '2026-05-08T20-40-10-ccc3333',
      '2026-05-07T20-40-10-ddd4444',
      '2026-05-06T20-40-10-eee5555',
    ]
    for (const s of stamps) {
      await fs.writeFile(path.join(snapDir, `snapshot-${s}.json`), '{}')
    }

    const removed = await pruneLegacySnapshots(snapDir, 2)
    expect(removed).toBe(3)

    const remaining = (await fs.readdir(snapDir))
      .filter((f) => /^snapshot-\d{4}-/.test(f))
      .sort()
      .reverse()
    expect(remaining).toHaveLength(2)
    expect(remaining[0]).toContain('aaa1111')
    expect(remaining[1]).toContain('bbb2222')
  })

  it('pruneLegacySnapshots no-op quand <= N fichiers présents', async () => {
    const snapDir = configFor(dir).snapshotDir
    await fs.mkdir(snapDir, { recursive: true })
    await fs.writeFile(
      path.join(snapDir, 'snapshot-2026-05-10T20-40-10-aaa1111.json'),
      '{}',
    )
    const removed = await pruneLegacySnapshots(snapDir, 2)
    expect(removed).toBe(0)
  })

  it('readSnapshotMeta fast path < 50ms (sidecar parse, pas le blob 3MB)', async () => {
    const config = configFor(dir)
    const meta: SnapshotMeta = {
      version: SNAPSHOT_VERSION,
      inputHash: 'fast-fixture',
      generatedAt: '2026-05-10T20:00:00.000Z',
      fileCount: 1,
    }
    // Écrit un payload artificiellement gros (1MB) pour vérifier que
    // la fast path ne le lit pas
    const bigPayload = {
      version: '1',
      generatedAt: '2026-05-10T20:00:00.000Z',
      rootDir: dir,
      nodes: Array.from({ length: 10_000 }, (_, i) => ({
        id: `file-${i}.ts`,
        label: `file-${i}.ts`,
        type: 'file',
        status: 'connected',
        tags: [],
      })),
      edges: [],
      stats: { totalFiles: 10_000 } as never,
    }
    await writeStoredSnapshot(config.snapshotDir, meta, bigPayload as never)

    const t0 = performance.now()
    const read = await readSnapshotMeta(config.snapshotDir)
    const ms = performance.now() - t0
    expect(read?.inputHash).toBe('fast-fixture')
    expect(ms).toBeLessThan(50)
  })

  it('snapshot.json absent + legacy présent → readStoredSnapshot null (fallback géré par loadSnapshot caller)', async () => {
    const snapDir = configFor(dir).snapshotDir
    await fs.mkdir(snapDir, { recursive: true })
    await fs.writeFile(
      path.join(snapDir, 'snapshot-2026-05-10T20-40-10-aaa1111.json'),
      JSON.stringify({ version: '1', nodes: [], edges: [] }),
    )
    const stored = await readStoredSnapshot(snapDir)
    expect(stored).toBeNull()
    // Le fichier v2 n'existe pas — sanity check
    let exists = false
    try {
      await fs.access(snapshotPath(snapDir))
      exists = true
    } catch {
      /* expected */
    }
    expect(exists).toBe(false)
  })
})
