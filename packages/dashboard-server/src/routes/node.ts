import type { FastifyInstance } from 'fastify'
import type { DashboardState } from '../state.js'
import { loadSnapshot } from '../state.js'

interface SnapshotShape {
  nodes?: Array<{ id: string; label?: string; type?: string; status?: string; tags?: string[] }>
  edges?: Array<{ id?: string; from: string; to: string; type?: string }>
  truthPoints?: Array<{ file: string; reason?: string }>
  longFunctions?: Array<{ file: string; name?: string; lines: number }>
  todos?: Array<{ file: string; line: number; text: string }>
  coChangePairs?: Array<{ a: string; b: string; coChangeRate: number; sharedCommits: number }>
  envUsage?: Array<{ file: string; var: string }>
  driftSignals?: Array<{ file?: string; kind?: string; detail?: string }>
}

interface NodeDetails {
  id: string
  type?: string
  status?: string
  tags?: string[]
  importers: Array<{ from: string; type?: string }>
  imports: Array<{ to: string; type?: string }>
  truthPoint?: { reason?: string }
  longFunctions: Array<{ name: string; lines: number }>
  todos: Array<{ line: number; text: string }>
  envVars: string[]
  driftSignals: Array<{ kind: string; detail: string }>
  coChange: Array<{ partner: string; rate: number; sharedCommits: number }>
}

function nodeFromSnap(snap: SnapshotShape, id: string): NodeDetails | null {
  const node = (snap.nodes ?? []).find((n) => n.id === id)
  if (!node) return null

  const importers: NodeDetails['importers'] = []
  const imports: NodeDetails['imports'] = []
  for (const e of snap.edges ?? []) {
    if (e.to === id) importers.push({ from: e.from, type: e.type })
    if (e.from === id) imports.push({ to: e.to, type: e.type })
  }

  const truth = (snap.truthPoints ?? []).find((tp) => tp.file === id)
  const longFunctions = (snap.longFunctions ?? [])
    .filter((lf) => lf.file === id)
    .map((lf) => ({ name: lf.name ?? '<anon>', lines: lf.lines }))
  const todos = (snap.todos ?? [])
    .filter((t) => t.file === id)
    .map((t) => ({ line: t.line, text: t.text }))
  const envVars = Array.from(
    new Set((snap.envUsage ?? []).filter((u) => u.file === id).map((u) => u.var)),
  )
  const driftSignals = (snap.driftSignals ?? [])
    .filter((d) => d.file === id)
    .map((d) => ({ kind: d.kind ?? 'drift', detail: d.detail ?? '' }))

  const coChange: NodeDetails['coChange'] = []
  for (const p of snap.coChangePairs ?? []) {
    let partner: string | null = null
    if (p.a === id) partner = p.b
    else if (p.b === id) partner = p.a
    if (partner) {
      coChange.push({ partner, rate: p.coChangeRate, sharedCommits: p.sharedCommits })
    }
  }
  coChange.sort((a, b) => b.rate - a.rate)

  return {
    id,
    type: node.type,
    status: node.status,
    tags: node.tags,
    importers,
    imports,
    truthPoint: truth ? { reason: truth.reason } : undefined,
    longFunctions,
    todos,
    envVars,
    driftSignals,
    coChange: coChange.slice(0, 20),
  }
}

export async function registerNodeRoutes(
  app: FastifyInstance,
  state: DashboardState,
): Promise<void> {
  app.get('/api/node', async (req, reply) => {
    const q = req.query as { id?: string }
    if (!q.id) {
      return reply.code(400).send({ error: 'id query param required' })
    }
    await loadSnapshot(state)
    if (!state.snapshotData) {
      return reply.code(404).send({ error: 'no snapshot' })
    }
    const details = nodeFromSnap(state.snapshotData as SnapshotShape, q.id)
    if (!details) {
      return reply.code(404).send({ error: 'node not in snapshot' })
    }
    return details
  })
}
