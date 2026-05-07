import type { FastifyInstance } from 'fastify'
import type { DashboardState } from '../state.js'
import { loadSnapshot } from '../state.js'

export async function registerSnapshotRoutes(
  app: FastifyInstance,
  state: DashboardState,
): Promise<void> {
  app.get('/api/snapshot', async (_req, reply) => {
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
    await loadSnapshot(state)
    if (!state.snapshotData) {
      return reply.code(404).send({ error: 'no snapshot' })
    }
    const data = state.snapshotData as { nodes?: unknown[]; edges?: unknown[]; commit?: string }
    return {
      source: state.snapshotPath,
      mtime: state.snapshotMtime,
      nodeCount: Array.isArray(data.nodes) ? data.nodes.length : 0,
      edgeCount: Array.isArray(data.edges) ? data.edges.length : 0,
      commit: data.commit ?? null,
    }
  })
}
