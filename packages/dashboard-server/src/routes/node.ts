import type { FastifyInstance } from 'fastify'
import type { DashboardState } from '../state.js'
import { loadSnapshot } from '../state.js'
import type { GraphSnapshot } from '@liby-tools/codegraph'

/**
 * Sub-shapes minimalistes — sous-ensemble strict des champs `GraphSnapshot`
 * réellement consommés par les extracteurs. Les guards type-level (cf.
 * `_AssignX` checks plus bas) garantissent que ces shapes restent
 * compatibles avec les vrais types — si `GraphSnapshot` évolue de
 * manière à casser l'assignabilité, la compile pète.
 *
 * Préalablement, ce fichier utilisait un fake `SnapshotShape` divergent
 * du vrai type, avec 5+ champs inexistants. La route renvoyait
 * majoritairement undefined / [] en production. Bugs corrigés ici :
 *   - `longFunctions[i].lines`       → réel `loc`
 *   - `todos[i].text`                → réel `message`
 *   - `envUsage[i].file / .var`      → réel structure { name, readers[{file, ...}] }
 *   - `driftSignals[i].detail`       → réel `message`
 *   - `coChangePairs[i].a/b/coChangeRate/sharedCommits` → réel `from/to/jaccard/count`
 *   - `truthPoints[i].file/reason`   → réel structure { concept, canonical?, writers, readers, mirrors, exposed }
 *
 * Le shape de RÉPONSE HTTP (NodeDetails) reste **stable** pour back-compat
 * avec le frontend dashboard — le code interne mappe les vrais champs vers
 * les noms legacy. Renommer l'API publique (`lines` → `loc`, `text` →
 * `message`, etc.) demande un changement frontend séparé, hors scope.
 */
interface NodeShape {
  id: string
  label?: string
  type: string
  status: string
  tags?: string[]
}
interface EdgeShape {
  id?: string
  from: string
  to: string
  type?: string
}
interface LongFnShape {
  file: string
  name: string
  loc: number
}
interface TodoShape {
  file: string
  line: number
  message: string
}
interface EnvUsageShape {
  name: string
  readers: ReadonlyArray<{ file: string }>
}
interface DriftShape {
  kind: string
  file: string
  message: string
}
interface CoChangeShape {
  from: string
  to: string
  jaccard: number
  count: number
}
interface TruthPointShape {
  concept: string
  canonical?: { name: string }
  writers: ReadonlyArray<{ file: string }>
  readers: ReadonlyArray<{ file: string }>
  mirrors: ReadonlyArray<{ file: string }>
  exposed: ReadonlyArray<{ file?: string }>
}

export interface NodeRouteInputs {
  nodes: readonly NodeShape[]
  edges: readonly EdgeShape[]
  longFunctions?: readonly LongFnShape[]
  todos?: readonly TodoShape[]
  envUsage?: readonly EnvUsageShape[]
  driftSignals?: readonly DriftShape[]
  coChangePairs?: readonly CoChangeShape[]
  truthPoints?: readonly TruthPointShape[]
}

// Type-level assignability guards — pètent à la compile si GraphSnapshot drift.
type _AssignNode = GraphSnapshot['nodes'][number] extends NodeShape ? true : never
type _AssignEdge = GraphSnapshot['edges'][number] extends EdgeShape ? true : never
type _AssignLongFn = NonNullable<GraphSnapshot['longFunctions']>[number] extends LongFnShape ? true : never
type _AssignTodo = NonNullable<GraphSnapshot['todos']>[number] extends TodoShape ? true : never
type _AssignEnv = NonNullable<GraphSnapshot['envUsage']>[number] extends EnvUsageShape ? true : never
type _AssignDrift = NonNullable<GraphSnapshot['driftSignals']>[number] extends DriftShape ? true : never
type _AssignCoChange = NonNullable<GraphSnapshot['coChangePairs']>[number] extends CoChangeShape ? true : never
type _AssignTruth = NonNullable<GraphSnapshot['truthPoints']>[number] extends TruthPointShape ? true : never
/* eslint-disable @typescript-eslint/no-unused-vars */
const _checkNode: _AssignNode = true
const _checkEdge: _AssignEdge = true
const _checkLongFn: _AssignLongFn = true
const _checkTodo: _AssignTodo = true
const _checkEnv: _AssignEnv = true
const _checkDrift: _AssignDrift = true
const _checkCoChange: _AssignCoChange = true
const _checkTruth: _AssignTruth = true
/* eslint-enable @typescript-eslint/no-unused-vars */

/**
 * Shape de réponse HTTP — **stable** pour back-compat frontend dashboard.
 * Les champs `lines`, `text`, `detail`, `rate`, `sharedCommits`, `reason`
 * sont des noms legacy ; en interne ils proviennent de `loc`, `message`,
 * `message`, `jaccard`, `count`, et d'une introspection du truth point.
 * Renommer ces champs demande un changement frontend (= autre PR).
 */
interface NodeDetails {
  id: string
  type: string
  status: string
  tags?: string[]
  importers: Array<{ from: string; type?: string }>
  imports: Array<{ to: string; type?: string }>
  truthPoint?: { reason: string }
  longFunctions: Array<{ name: string; lines: number }>
  todos: Array<{ line: number; text: string }>
  envVars: string[]
  driftSignals: Array<{ kind: string; detail: string }>
  coChange: Array<{ partner: string; rate: number; sharedCommits: number }>
}

export function extractEdges(snap: NodeRouteInputs, id: string): {
  importers: NodeDetails['importers']
  imports: NodeDetails['imports']
} {
  const importers: NodeDetails['importers'] = []
  const imports: NodeDetails['imports'] = []
  for (const e of snap.edges) {
    if (e.to === id) importers.push({ from: e.from, type: e.type })
    if (e.from === id) imports.push({ to: e.to, type: e.type })
  }
  return { importers, imports }
}

export function extractLongFunctions(snap: NodeRouteInputs, id: string): NodeDetails['longFunctions'] {
  return (snap.longFunctions ?? [])
    .filter((lf) => lf.file === id)
    // Fix : champ réel = `loc`, exposé en `lines` côté API (legacy name).
    .map((lf) => ({ name: lf.name, lines: lf.loc }))
}

export function extractTodos(snap: NodeRouteInputs, id: string): NodeDetails['todos'] {
  return (snap.todos ?? [])
    .filter((t) => t.file === id)
    // Fix : champ réel = `message`, exposé en `text` côté API (legacy name).
    .map((t) => ({ line: t.line, text: t.message }))
}

export function extractEnvVars(snap: NodeRouteInputs, id: string): string[] {
  // Fix structural : `envUsage[i]` est `{ name, readers: [{file, ...}] }` —
  // un fichier consomme une env var s'il apparaît dans `readers`. Préalablement,
  // le code accédait `u.file` et `u.var` qui n'existaient pas (= toujours []).
  const names = new Set<string>()
  for (const usage of snap.envUsage ?? []) {
    if (usage.readers.some((r) => r.file === id)) {
      names.add(usage.name)
    }
  }
  return [...names].sort()
}

export function extractDriftSignals(snap: NodeRouteInputs, id: string): NodeDetails['driftSignals'] {
  return (snap.driftSignals ?? [])
    .filter((d) => d.file === id)
    // Fix : champ réel = `message`, exposé en `detail` côté API (legacy name).
    // d.kind est non-optional dans le vrai type — plus de fallback 'drift'.
    .map((d) => ({ kind: d.kind, detail: d.message }))
}

export function extractCoChange(snap: NodeRouteInputs, id: string): NodeDetails['coChange'] {
  const out: NodeDetails['coChange'] = []
  for (const p of snap.coChangePairs ?? []) {
    // Fix : champs réels = `from/to` (pas `a/b`).
    const partner = p.from === id ? p.to : p.to === id ? p.from : null
    if (!partner) continue
    // Fix : champs réels = `jaccard/count`, exposés en `rate/sharedCommits`.
    out.push({ partner, rate: p.jaccard, sharedCommits: p.count })
  }
  out.sort((a, b) => b.rate - a.rate)
  return out.slice(0, 20)
}

/**
 * Trouve le premier truth point dans lequel ce fichier joue un rôle.
 * Préalablement, le code faisait `truthPoints.find(tp => tp.file === id)` —
 * mais `TruthPoint` n'a pas de champ `file`. Un truth point réel a
 * un `concept` + des collections `writers`, `readers`, `mirrors`, `exposed`,
 * et un `canonical` optionnel.
 *
 * On retourne le rôle joué par le fichier dans le truth point (canonical
 * > writer > reader > mirror > exposed), exposé via le champ `reason`
 * legacy de l'API.
 */
export function extractTruthPoint(
  snap: NodeRouteInputs,
  id: string,
): NodeDetails['truthPoint'] {
  for (const tp of snap.truthPoints ?? []) {
    if (tp.canonical?.name === id) return { reason: `canonical for "${tp.concept}"` }
    if (tp.writers.some((w) => w.file === id)) return { reason: `writer for "${tp.concept}"` }
    if (tp.readers.some((r) => r.file === id)) return { reason: `reader for "${tp.concept}"` }
    if (tp.mirrors.some((m) => m.file === id)) return { reason: `mirror for "${tp.concept}"` }
    if (tp.exposed.some((e) => e.file === id)) return { reason: `exposed for "${tp.concept}"` }
  }
  return undefined
}

export function nodeFromSnap(snap: NodeRouteInputs, id: string): NodeDetails | null {
  const node = snap.nodes.find((n) => n.id === id)
  if (!node) return null
  const { importers, imports } = extractEdges(snap, id)
  return {
    id,
    type: node.type,
    status: node.status,
    tags: node.tags,
    importers,
    imports,
    truthPoint: extractTruthPoint(snap, id),
    longFunctions: extractLongFunctions(snap, id),
    todos: extractTodos(snap, id),
    envVars: extractEnvVars(snap, id),
    driftSignals: extractDriftSignals(snap, id),
    coChange: extractCoChange(snap, id),
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
    const snapshot = state.snapshotData as GraphSnapshot
    const inputs: NodeRouteInputs = {
      nodes: snapshot.nodes,
      edges: snapshot.edges,
      longFunctions: snapshot.longFunctions,
      todos: snapshot.todos,
      envUsage: snapshot.envUsage,
      driftSignals: snapshot.driftSignals,
      coChangePairs: snapshot.coChangePairs,
      truthPoints: snapshot.truthPoints,
    }
    const details = nodeFromSnap(inputs, q.id)
    if (!details) {
      return reply.code(404).send({ error: 'node not in snapshot' })
    }
    return details
  })
}
