import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { DashboardState } from '../state.js'
import type { GraphSnapshot } from '@liby-tools/codegraph'
import { unwrapSnapshot, isSafeSnapshotFilename } from '@liby-tools/codegraph/snapshot-loader'

/**
 * Sub-shapes minimalistes — sous-ensemble strict des champs `GraphSnapshot`
 * réellement consommés par les comptes de diff. Les guards type-level
 * (`_AssignX` plus bas) garantissent l'assignabilité avec les vrais
 * types — si `GraphSnapshot` évolue de manière à casser, la compile pète.
 *
 * Préalablement, ce fichier utilisait un fake `SnapshotShape` divergent :
 *   - `cycles[].files`                → réel `nodes` (utilisé ici seulement
 *                                       pour .length, donc on garde la forme
 *                                       minimale `unknown[]`)
 *   - `longFunctions[].lines`         → réel `loc` (bug : le filter `>= 80`
 *                                       renvoyait toujours [], donc
 *                                       longFunctionsAdded/Removed était
 *                                       figé à 0 en prod)
 *
 * Identifié par l'audit dette architecturale 2026-05-12 §T1.2, fixé ici
 * par le même pattern que routes/node.ts (PR #65) et routes/tensions.ts
 * (PR #66).
 */
interface NodeShape {
  id: string
}
interface EdgeShape {
  id: string
  from: string
  to: string
}
interface BarrelShape {
  file: string
  lowValue: boolean
}
interface LongFnShape {
  file: string
  loc: number
}

export interface DiffSnapshotShape {
  nodes?: readonly NodeShape[]
  edges?: readonly EdgeShape[]
  cycles?: readonly unknown[]
  barrels?: readonly BarrelShape[]
  longFunctions?: readonly LongFnShape[]
  generatedAt?: string
  commitHash?: string
}

// Type-level assignability guards — pètent à la compile si GraphSnapshot drift.
type _AssignNode = GraphSnapshot['nodes'][number] extends NodeShape ? true : never
type _AssignEdge = GraphSnapshot['edges'][number] extends EdgeShape ? true : never
type _AssignBarrel = NonNullable<GraphSnapshot['barrels']>[number] extends BarrelShape ? true : never
type _AssignLongFn = NonNullable<GraphSnapshot['longFunctions']>[number] extends LongFnShape ? true : never
/* eslint-disable @typescript-eslint/no-unused-vars */
const _checkNode: _AssignNode = true
const _checkEdge: _AssignEdge = true
const _checkBarrel: _AssignBarrel = true
const _checkLongFn: _AssignLongFn = true
/* eslint-enable @typescript-eslint/no-unused-vars */

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

// ADR-027 — validation + unwrap centralisés dans le loader unifié.
function safeFilename(name: string): string | null {
  const base = path.basename(name)
  return isSafeSnapshotFilename(base) ? base : null
}

async function loadSnap(codegraphDir: string, file: string): Promise<DiffSnapshotShape | null> {
  try {
    const text = await fs.readFile(path.join(codegraphDir, file), 'utf-8')
    return unwrapSnapshot(JSON.parse(text)) as DiffSnapshotShape
  } catch {
    return null
  }
}

export function diffSets(a: string[], b: string[]): { added: string[]; removed: string[]; commonCount: number } {
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

export function countTensionDelta(from: DiffSnapshotShape, to: DiffSnapshotShape): DiffResult['tensions'] {
  const fromCycles = (from.cycles ?? []).length
  const toCycles = (to.cycles ?? []).length
  const fromLowBarrels = (from.barrels ?? []).filter((b) => b.lowValue).length
  const toLowBarrels = (to.barrels ?? []).filter((b) => b.lowValue).length
  // Field réel = `loc` (cf. GraphSnapshot.longFunctions). L'ancien code
  // lisait `lf.lines` (fake type) qui était systématiquement undefined →
  // filter renvoyait toujours [] → counts figés à 0 en prod (audit T1.2).
  const fromLongFns = (from.longFunctions ?? []).filter((lf) => lf.loc >= 80).length
  const toLongFns = (to.longFunctions ?? []).filter((lf) => lf.loc >= 80).length
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
