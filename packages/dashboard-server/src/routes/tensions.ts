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

function fromCycles(data: SnapshotShape): Tension[] {
  return (data.cycles ?? []).map((c) => ({
    kind: 'cycle',
    target: c.files.join(' → '),
    detail: `cycle de ${c.files.length} fichiers`,
    hint: 'casser une arête (extract module commun) ou inverser une dépendance',
  }))
}

function fromBarrels(data: SnapshotShape): Tension[] {
  return (data.barrels ?? [])
    .filter((b) => b.lowValue)
    .map((b) => ({
      kind: 'barrel-low',
      target: b.file,
      detail: `${b.reExportCount} re-export(s) pour ${b.consumerCount} consumer(s)`,
      hint: 'inline les imports et supprime le barrel',
    }))
}

function fromOrphans(data: SnapshotShape): Tension[] {
  return (data.nodes ?? [])
    .filter((n) => n.status === 'disconnected' && n.type === 'file')
    .map((n) => ({
      kind: 'orphan',
      target: n.id,
      detail: 'aucun importeur',
      hint: 'supprime + npm test : si vert mort, si rouge entry-point caché',
    }))
}

function fromLongFunctions(data: SnapshotShape): Tension[] {
  return (data.longFunctions ?? [])
    .filter((lf) => lf.lines >= 80)
    .map((lf) => ({
      kind: 'long-fn',
      target: `${lf.file}::${lf.name ?? '<anon>'}`,
      detail: `${lf.lines} lignes`,
      hint: 'extract sous-fonctions par phase',
    }))
}

function fromDriftSignals(data: SnapshotShape): Tension[] {
  return (data.driftSignals ?? []).map((d) => ({
    kind: d.kind ?? 'drift',
    target: d.file ?? 'unknown',
    detail: d.detail ?? '',
    hint: 'investigate: pattern qui dérive de la convention du repo',
  }))
}

const TENSION_BUILDERS: Array<(d: SnapshotShape) => Tension[]> = [
  fromCycles,
  fromBarrels,
  fromOrphans,
  fromLongFunctions,
  fromDriftSignals,
]

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
    const tensions = TENSION_BUILDERS.flatMap((build) => build(data))
    return { count: tensions.length, tensions }
  })
}
