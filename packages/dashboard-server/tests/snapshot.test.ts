import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseSnapshotName, getSnapshotMeta } from '../src/routes/snapshot.js'

describe('parseSnapshotName', () => {
  it('parses a valid snapshot filename', () => {
    const r = parseSnapshotName('snapshot-2026-05-06T20-25-01-e9b880a.json')
    expect(r).toEqual({
      ts: '2026-05-06T20-25-01',
      sha: 'e9b880a',
      isoDate: '2026-05-06T20:25:01Z',
    })
  })

  it('returns null for snapshot-live.json', () => {
    expect(parseSnapshotName('snapshot-live.json')).toBeNull()
  })

  it('returns null for arbitrary filenames', () => {
    expect(parseSnapshotName('foo.json')).toBeNull()
    expect(parseSnapshotName('snapshot.json')).toBeNull()
    expect(parseSnapshotName('not-a-snapshot.json')).toBeNull()
  })

  it('returns null when sha contains uppercase or non-hex', () => {
    expect(parseSnapshotName('snapshot-2026-05-06T20-25-01-DEADBEEF.json')).toBeNull()
    expect(parseSnapshotName('snapshot-2026-05-06T20-25-01-zzzzzzz.json')).toBeNull()
  })

  it('handles short and long sha (any hex length)', () => {
    expect(parseSnapshotName('snapshot-2026-05-06T20-25-01-abc.json')?.sha).toBe('abc')
    expect(parseSnapshotName('snapshot-2026-05-06T20-25-01-abcdef0123456789abcdef0123456789abcdef01.json')?.sha)
      .toBe('abcdef0123456789abcdef0123456789abcdef01')
  })
})

// ADR-033 Phase 3 — première migration consumer (route /api/snapshot/meta).
describe('getSnapshotMeta — ADR-033 Phase 3', () => {
  /**
   * Écrit un snapshot.json minimaliste au format v3 (= wrapper ADR-027
   * Phase 2 + ADR-033 Phase 1, structurellement identique). Pas besoin
   * de lancer `analyze` complet — `getSnapshotMeta` consomme juste les
   * champs `GraphCore`, on les pose à la main.
   */
  async function writeMinimalSnapshot(
    snapshotDir: string,
    overrides: { nodes?: unknown[]; edges?: unknown[]; commitHash?: string } = {},
  ): Promise<void> {
    await fs.mkdir(snapshotDir, { recursive: true })
    const payload = {
      version: '1',
      generatedAt: '2026-05-11T00:00:00Z',
      rootDir: '/fake',
      commitHash: overrides.commitHash,
      nodes: overrides.nodes ?? [{ id: 'a.ts', label: 'a.ts', type: 'file', status: 'orphan', tags: [] }],
      edges: overrides.edges ?? [],
      stats: {
        totalFiles: 1, totalEdges: 0, orphanCount: 1, connectedCount: 0,
        entryPointCount: 0, uncertainCount: 0, healthScore: 1,
        edgesByType: { import: 0, event: 0, route: 0, queue: 0, 'dynamic-load': 0, 'db-table': 0 },
      },
    }
    const wrapper = {
      version: 3,
      meta: {
        version: 3,
        inputHash: 'a'.repeat(64),
        generatedAt: payload.generatedAt,
      },
      payload,
    }
    await fs.writeFile(
      path.join(snapshotDir, 'snapshot.json'),
      JSON.stringify(wrapper),
      'utf-8',
    )
  }

  it('returns null when no snapshot.json exists', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-empty-'))
    try {
      const meta = await getSnapshotMeta(dir)
      expect(meta).toBeNull()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('returns nodeCount/edgeCount from GraphCore (not from full payload)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-counts-'))
    try {
      await writeMinimalSnapshot(dir, {
        nodes: [
          { id: 'a.ts', label: 'a.ts', type: 'file', status: 'orphan', tags: [] },
          { id: 'b.ts', label: 'b.ts', type: 'file', status: 'connected', tags: [] },
          { id: 'c.ts', label: 'c.ts', type: 'file', status: 'connected', tags: [] },
        ],
        edges: [
          { id: 'e1', from: 'b.ts', to: 'c.ts', type: 'import', resolved: true },
        ],
      })
      const meta = await getSnapshotMeta(dir)
      expect(meta).not.toBeNull()
      expect(meta!.nodeCount).toBe(3)
      expect(meta!.edgeCount).toBe(1)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('returns commit from commitHash (fix collatéral : was data.commit which never existed)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-commit-'))
    try {
      await writeMinimalSnapshot(dir, { commitHash: 'deadbeef1234' })
      const meta = await getSnapshotMeta(dir)
      expect(meta?.commit).toBe('deadbeef1234')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('returns commit=null when commitHash absent (no git repo)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-nocommit-'))
    try {
      await writeMinimalSnapshot(dir, { commitHash: undefined })
      const meta = await getSnapshotMeta(dir)
      expect(meta?.commit).toBeNull()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('source path points to snapshot.json + mtime is real fs stat', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-source-'))
    try {
      await writeMinimalSnapshot(dir)
      const meta = await getSnapshotMeta(dir)
      expect(meta?.source).toBe(path.join(dir, 'snapshot.json'))
      expect(meta?.mtime).toBeGreaterThan(0)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
