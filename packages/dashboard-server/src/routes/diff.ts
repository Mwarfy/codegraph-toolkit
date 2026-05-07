import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { DashboardState } from '../state.js'

interface SnapshotShape {
  nodes?: Array<{ id: string; type?: string; status?: string }>
  edges?: Array<{ id: string; from: string; to: string; type?: string }>
  cycles?: Array<{ files: string[] }>
  barrels?: Array<{ file: string; lowValue?: boolean }>
  longFunctions?: Array<{ file: string; name?: string; lines: number }>
  generatedAt?: string
  commitHash?: string
}

interface DiffResult {
  from: { file: string; commit: string | undefined; generatedAt: string | undefined }
  to: { file: string; commit: string | undefined; generatedAt: string | undefined }
  nodes: { added: string[]; removed: string[]; commonCount: number }
  edges: { added: string[]; removed: string[]; commonCount: number }
  tensions: {
    cyclesAdded: number
    cyclesRemoved: number
    barrelsLowAdded: number
    barrelsLowRemoved: number
    longFunctionsAdded: number
    longFunctionsRemoved: number
  }
}

function safeFilename(name: string): string | null {
  const base = path.basename(name)
  if (!base.startsWith('snapshot-') || !base.endsWith('.json')) return null
  return base
}

async function loadSnap(codegraphDir: string, file: string): Promise<SnapshotShape | null> {
  try {
    const text = await fs.readFile(path.join(codegraphDir, file), 'utf-8')
    return JSON.parse(text) as SnapshotShape
  } catch {
    return null
  }
}

function diffSets(a: string[], b: string[]): { added: string[]; removed: string[]; commonCount: number } {
  const sa = new Set(a)
  const sb = new Set(b)
  const added: string[] = []
  const removed: string[] = []
  for (const x of sb) if (!sa.has(x)) added.push(x)
  for (const x of sa) if (!sb.has(x)) removed.push(x)
  let common = 0
  for (const x of sa) if (sb.has(x)) common++
  return { added, removed, commonCount: common }
}

function countTensionDelta(from: SnapshotShape, to: SnapshotShape): DiffResult['tensions'] {
  const fromCycles = (from.cycles ?? []).length
  const toCycles = (to.cycles ?? []).length
  const fromLowBarrels = (from.barrels ?? []).filter((b) => b.lowValue).length
  const toLowBarrels = (to.barrels ?? []).filter((b) => b.lowValue).length
  const fromLongFns = (from.longFunctions ?? []).filter((lf) => lf.lines >= 80).length
  const toLongFns = (to.longFunctions ?? []).filter((lf) => lf.lines >= 80).length
  return {
    cyclesAdded: Math.max(0, toCycles - fromCycles),
    cyclesRemoved: Math.max(0, fromCycles - toCycles),
    barrelsLowAdded: Math.max(0, toLowBarrels - fromLowBarrels),
    barrelsLowRemoved: Math.max(0, fromLowBarrels - toLowBarrels),
    longFunctionsAdded: Math.max(0, toLongFns - fromLongFns),
    longFunctionsRemoved: Math.max(0, fromLongFns - toLongFns),
  }
}

export async function registerDiffRoutes(
  app: FastifyInstance,
  state: DashboardState,
): Promise<void> {
  app.get('/api/diff', async (req, reply) => {
    const q = req.query as { from?: string; to?: string }
    if (!q.from || !q.to) {
      return reply.code(400).send({ error: 'from and to query params required' })
    }
    const fromName = safeFilename(q.from)
    const toName = safeFilename(q.to)
    if (!fromName || !toName) {
      return reply.code(400).send({ error: 'invalid snapshot filename' })
    }
    const [fromSnap, toSnap] = await Promise.all([
      loadSnap(state.codegraphDir, fromName),
      loadSnap(state.codegraphDir, toName),
    ])
    if (!fromSnap || !toSnap) {
      return reply.code(404).send({ error: 'one or both snapshots not found' })
    }

    const fromNodes = (fromSnap.nodes ?? []).map((n) => n.id)
    const toNodes = (toSnap.nodes ?? []).map((n) => n.id)
    const fromEdges = (fromSnap.edges ?? []).map((e) => e.id)
    const toEdges = (toSnap.edges ?? []).map((e) => e.id)

    const result: DiffResult = {
      from: { file: fromName, commit: fromSnap.commitHash, generatedAt: fromSnap.generatedAt },
      to: { file: toName, commit: toSnap.commitHash, generatedAt: toSnap.generatedAt },
      nodes: diffSets(fromNodes, toNodes),
      edges: diffSets(fromEdges, toEdges),
      tensions: countTensionDelta(fromSnap, toSnap),
    }
    return result
  })
}
