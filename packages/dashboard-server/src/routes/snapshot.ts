import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { DashboardState } from '../state.js'
import { loadSnapshot } from '../state.js'
import {
  loadSnapshotFromFile,
  isSafeSnapshotFilename,
  loadGraphCore,
} from '@liby-tools/codegraph/snapshot-loader'

interface SnapshotEntry {
  file: string
  ts: string
  sha: string
  isoDate: string
  bytes: number
}

/**
 * Filename pattern: snapshot-<ISO-with-dashes>-<sha>.json
 * Example: snapshot-2026-05-06T20-25-01-e9b880a.json
 */
export function parseSnapshotName(filename: string): { ts: string; sha: string; isoDate: string } | null {
  const m = filename.match(/^snapshot-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-([a-f0-9]+)\.json$/)
  if (!m) return null
  const [, ts, sha] = m
  // Restore ISO format: replace last 3 dashes (in time portion) with colons.
  const isoDate = ts.replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})$/, '$1:$2:$3') + 'Z'
  return { ts, sha, isoDate }
}

// ADR-027 — `loadSnapshotFromFile` + `isSafeSnapshotFilename` viennent
// du loader unifié `@liby-tools/codegraph/snapshot-loader`.

export interface SnapshotMetaResult {
  source: string
  mtime: number
  nodeCount: number
  edgeCount: number
  commit: string | null
}

/**
 * ADR-033 Phase 3 — première migration consumer. Ne consomme que les
 * champs `GraphCore` (nodes, edges, commitHash) — pas besoin de charger
 * les detector outputs ni les metrics en RAM.
 *
 * Fonction pure exportée pour tests unitaires (= pas de setup Fastify).
 * Retourne `null` si aucun snapshot n'est trouvé.
 *
 * Trade-off : `loadGraphCore` lit `snapshot.json` directement, donc ne
 * voit PAS le `snapshot-live.json` legacy (artefact watcher pré-Phase-2
 * ADR-027 conservé pour /api/snapshot). Aligné avec la direction
 * ADR-033 où snapshot.json est authoritative.
 */
export async function getSnapshotMeta(
  codegraphDir: string,
): Promise<SnapshotMetaResult | null> {
  const core = await loadGraphCore(codegraphDir)
  if (!core) return null
  const snapshotFile = path.join(codegraphDir, 'snapshot.json')
  const stat = await fs.stat(snapshotFile).catch(() => null)
  return {
    source: snapshotFile,
    mtime: stat?.mtimeMs ?? 0,
    nodeCount: core.nodes.length,
    edgeCount: core.edges.length,
    // Fix collatéral : était `data.commit` qui retournait toujours `null`
    // — le champ s'appelle `commitHash` dans GraphCore.
    commit: core.commitHash ?? null,
  }
}

export async function registerSnapshotRoutes(
  app: FastifyInstance,
  state: DashboardState,
): Promise<void> {
  app.get('/api/snapshot', async (req, reply) => {
    const q = req.query as { file?: string }
    if (q.file) {
      // Ad-hoc load of a historical snapshot — does NOT mutate state.
      // Validates that the requested file lives in .codegraph/ to prevent
      // path traversal.
      const safeName = path.basename(q.file)
      // ADR-027 — validation centralisée dans le loader unifié.
      if (!isSafeSnapshotFilename(safeName)) {
        return reply.code(400).send({ error: 'invalid snapshot filename' })
      }
      const abs = path.join(state.codegraphDir, safeName)
      try {
        const data = await loadSnapshotFromFile(abs)
        const stat = await fs.stat(abs)
        return { source: abs, mtime: stat.mtimeMs, data }
      } catch {
        return reply.code(404).send({ error: 'snapshot not found' })
      }
    }

    await loadSnapshot(state)
    if (!state.snapshotData) {
      return reply.code(404).send({ error: 'no snapshot found in .codegraph/' })
    }
    return {
      source: state.snapshotPath,
      mtime: state.snapshotMtime,
      data: state.snapshotData,
    }
  })

  app.get('/api/snapshot/meta', async (_req, reply) => {
    const meta = await getSnapshotMeta(state.codegraphDir)
    if (!meta) {
      return reply.code(404).send({ error: 'no snapshot' })
    }
    return meta
  })

  app.get('/api/snapshots', async () => {
    let entries: string[]
    try {
      entries = await fs.readdir(state.codegraphDir)
    } catch {
      return { count: 0, snapshots: [] as SnapshotEntry[] }
    }
    // Parallel stat — N=50 entries on a typical repo, sequential await
    // adds ~50ms × N for nothing.
    const candidates = entries
      .map((filename) => {
        const parsed = parseSnapshotName(filename)
        return parsed ? { filename, parsed } : null
      })
      .filter((c): c is { filename: string; parsed: NonNullable<ReturnType<typeof parseSnapshotName>> } => c !== null)

    const out = await Promise.all(
      candidates.map(async ({ filename, parsed }): Promise<SnapshotEntry | null> => {
        try {
          const stat = await fs.stat(path.join(state.codegraphDir, filename))
          return { file: filename, ...parsed, bytes: stat.size }
        } catch {
          return null
        }
      }),
    ).then((results) => results.filter((r): r is SnapshotEntry => r !== null))

    out.sort((a, b) => a.ts.localeCompare(b.ts))
    return { count: out.length, snapshots: out }
  })
}
