import type { FastifyInstance } from 'fastify'
import type { DashboardState } from '../state.js'
import { loadSnapshot } from '../state.js'

interface Tension {
  kind: string
  target: string
  detail: string
  hint: string
}

interface SnapshotShape {
  nodes?: Array<{ id: string; status?: string; type?: string }>
  edges?: Array<{ from: string; to: string }>
  cycles?: Array<{ files: string[] }>
  barrels?: Array<{ file: string; reExportCount: number; consumerCount: number; lowValue?: boolean }>
  todos?: Array<{ file: string; line: number; text: string }>
  longFunctions?: Array<{ file: string; name?: string; lines: number }>
  driftSignals?: Array<{ kind?: string; file?: string; detail?: string }>
}

export async function registerTensionRoutes(
  app: FastifyInstance,
  state: DashboardState,
): Promise<void> {
  app.get('/api/tensions', async (_req, reply) => {
    await loadSnapshot(state)
    if (!state.snapshotData) {
      return reply.code(404).send({ error: 'no snapshot' })
    }
    const data = state.snapshotData as SnapshotShape
    const tensions: Tension[] = []

    for (const c of data.cycles ?? []) {
      tensions.push({
        kind: 'cycle',
        target: c.files.join(' → '),
        detail: `cycle de ${c.files.length} fichiers`,
        hint: 'casser une arête (extract module commun) ou inverser une dépendance',
      })
    }

    for (const b of data.barrels ?? []) {
      if (!b.lowValue) continue
      tensions.push({
        kind: 'barrel-low',
        target: b.file,
        detail: `${b.reExportCount} re-export(s) pour ${b.consumerCount} consumer(s)`,
        hint: 'inline les imports et supprime le barrel',
      })
    }

    for (const node of data.nodes ?? []) {
      if (node.status === 'disconnected' && node.type === 'file') {
        tensions.push({
          kind: 'orphan',
          target: node.id,
          detail: 'aucun importeur',
          hint: 'supprime + npm test : si vert mort, si rouge entry-point caché',
        })
      }
    }

    for (const lf of data.longFunctions ?? []) {
      if (lf.lines >= 80) {
        tensions.push({
          kind: 'long-fn',
          target: `${lf.file}::${lf.name ?? '<anon>'}`,
          detail: `${lf.lines} lignes`,
          hint: 'extract sous-fonctions par phase',
        })
      }
    }

    for (const d of data.driftSignals ?? []) {
      tensions.push({
        kind: d.kind ?? 'drift',
        target: d.file ?? 'unknown',
        detail: d.detail ?? '',
        hint: 'investigate: pattern qui dérive de la convention du repo',
      })
    }

    return { count: tensions.length, tensions }
  })
}
