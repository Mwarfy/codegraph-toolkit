import type { FastifyInstance } from 'fastify'
import type { DashboardState } from '../state.js'
import { loadSnapshot } from '../state.js'
import type { GraphSnapshot } from '@liby-tools/codegraph'

export interface Tension {
  kind: string
  target: string
  detail: string
  hint: string
}

/**
 * Shapes minimalistes — sous-ensemble des champs `GraphSnapshot`
 * réellement consommés par les tension builders. Avantage : coupling
 * minimal vs le snapshot complet, fixtures de test légères.
 *
 * Préalablement, ce fichier utilisait un fake `SnapshotShape` avec des
 * champs qui ne correspondaient pas au snapshot sérialisé :
 *   - `cycles[i].files`         → réel `Cycle.nodes`
 *   - `nodes[i].status === 'disconnected'` → réel `'orphan'`
 *   - `longFunctions[i].lines`  → réel `loc`
 *   - `driftSignals[i].detail`  → réel `message`
 *
 * Conséquence : la route ne renvoyait majoritairement rien en production
 * (les filtres ne matchaient aucun fact). Ce cleanup expose les vrais
 * signaux. Préparatif à la migration loader Phase 3 ADR-033.
 */
export interface TensionNode {
  id: string
  status: string
  type: string
}
export interface TensionCycle {
  nodes: readonly string[]
  size: number
}
export interface TensionBarrel {
  file: string
  reExportCount: number
  consumerCount: number
  lowValue: boolean
}
export interface TensionLongFn {
  file: string
  name: string
  loc: number
}
export interface TensionDriftSignal {
  kind: string
  file: string
  message: string
}

export interface TensionInputs {
  nodes: readonly TensionNode[]
  cycles?: readonly TensionCycle[]
  barrels?: readonly TensionBarrel[]
  longFunctions?: readonly TensionLongFn[]
  driftSignals?: readonly TensionDriftSignal[]
}

/**
 * Type-level guarantee : les sub-shapes ci-dessus sont compatibles avec
 * les sub-types réels de `GraphSnapshot`. Si le vrai type évolue de
 * manière à casser cette assignabilité, la compile pète ici — pas en
 * silence à la prochaine requête `/api/tensions`.
 */
type _AssignNode = GraphSnapshot['nodes'][number] extends TensionNode ? true : never
type _AssignCycle = NonNullable<GraphSnapshot['cycles']>[number] extends TensionCycle ? true : never
type _AssignBarrel = NonNullable<GraphSnapshot['barrels']>[number] extends TensionBarrel ? true : never
type _AssignLongFn = NonNullable<GraphSnapshot['longFunctions']>[number] extends TensionLongFn ? true : never
type _AssignDrift = NonNullable<GraphSnapshot['driftSignals']>[number] extends TensionDriftSignal ? true : never
/* eslint-disable @typescript-eslint/no-unused-vars */
const _checkNode: _AssignNode = true
const _checkCycle: _AssignCycle = true
const _checkBarrel: _AssignBarrel = true
const _checkLongFn: _AssignLongFn = true
const _checkDrift: _AssignDrift = true
/* eslint-enable @typescript-eslint/no-unused-vars */

export function fromCycles(data: TensionInputs): Tension[] {
  return (data.cycles ?? []).map((c) => ({
    kind: 'cycle',
    // Cycle.nodes est un path fermé [a, b, ..., a]. join donne un rendu humain.
    target: c.nodes.join(' → '),
    // c.size = nombre de fichiers uniques du cycle (= nodes.length - 1, car
    // premier == dernier dans le path).
    detail: `cycle de ${c.size} fichiers`,
    hint: 'casser une arête (extract module commun) ou inverser une dépendance',
  }))
}

export function fromBarrels(data: TensionInputs): Tension[] {
  return (data.barrels ?? [])
    .filter((b) => b.lowValue)
    .map((b) => ({
      kind: 'barrel-low',
      target: b.file,
      detail: `${b.reExportCount} re-export(s) pour ${b.consumerCount} consumer(s)`,
      hint: 'inline les imports et supprime le barrel',
    }))
}

export function fromOrphans(data: TensionInputs): Tension[] {
  // Fix : `'disconnected'` n'a jamais existé. Le vrai status pour un fichier
  // sans importeur est `'orphan'` (cf. `NodeStatus` dans core/types.ts).
  return data.nodes
    .filter((n) => n.status === 'orphan' && n.type === 'file')
    .map((n) => ({
      kind: 'orphan',
      target: n.id,
      detail: 'aucun importeur',
      hint: 'supprime + npm test : si vert mort, si rouge entry-point caché',
    }))
}

export function fromLongFunctions(data: TensionInputs): Tension[] {
  return (data.longFunctions ?? [])
    // Fix : champ réel = `loc` (lines-of-code), pas `lines`.
    .filter((lf) => lf.loc >= 80)
    .map((lf) => ({
      kind: 'long-fn',
      // lf.name est non-optional dans le vrai type (cf. DetectorOutputs).
      target: `${lf.file}::${lf.name}`,
      detail: `${lf.loc} lignes`,
      hint: 'extract sous-fonctions par phase',
    }))
}

export function fromDriftSignals(data: TensionInputs): Tension[] {
  return (data.driftSignals ?? []).map((d) => ({
    // d.kind et d.message sont non-optional dans le vrai type.
    kind: d.kind,
    target: d.file,
    // Fix : champ réel = `message` (texte humain du drift), pas `detail`.
    detail: d.message,
    hint: 'investigate: pattern qui dérive de la convention du repo',
  }))
}

const TENSION_BUILDERS: Array<(d: TensionInputs) => Tension[]> = [
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
    // state.snapshotData est typé `unknown` côté state.ts — il vient
    // pourtant d'un `GraphSnapshot`. On le typecaste localement (la
    // migration vers loadGraphCore + loadDetectorOutput viendra en
    // PR Phase 3 séparée, sur cette base type-clean).
    const snapshot = state.snapshotData as GraphSnapshot
    const inputs: TensionInputs = {
      nodes: snapshot.nodes,
      cycles: snapshot.cycles,
      barrels: snapshot.barrels,
      longFunctions: snapshot.longFunctions,
      driftSignals: snapshot.driftSignals,
    }
    const tensions = TENSION_BUILDERS.flatMap((build) => build(inputs))
    return { count: tensions.length, tensions }
  })
}
