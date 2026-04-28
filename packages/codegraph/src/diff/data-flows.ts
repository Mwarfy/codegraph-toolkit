/**
 * Data flows diff — phase 3 du PLAN.md.
 *
 * Matching par `entry.id` + `entry.kind` (ex: `http-route|POST /api/foo`).
 * Un flow apparaît/disparaît si son entry-point est nouveau ou supprimé.
 * Pour les flows qui persistent, on compare :
 *   - les `sinks` par clé (kind + target + file + line)
 *   - les tailles de `steps` (compteur avant/après — le contenu des
 *     steps change constamment avec la ligne des call sites, on évite
 *     de le lister)
 *
 * Un flow dont rien ne bouge n'apparaît pas dans `changed`.
 */

import type { DataFlow, DataFlowSink, GraphSnapshot } from '../core/types.js'
import type { DataFlowChange, DataFlowsDiff } from './types.js'

function flowKey(f: DataFlow): string {
  return `${f.entry.kind}\u0000${f.entry.id}`
}
// Matching par identité logique (phase 3.5) — ligne exclue de la clé.
// Deux appels à `db.query('INSERT INTO users ...')` dans le même fichier
// à des lignes différentes sont structurellement équivalents ; la ligne
// reste affichée dans la sortie mais ne crée plus de churn.
function sinkKey(s: DataFlowSink): string {
  return [s.kind, s.target, s.file].join('\u0000')
}

function diffFlow(before: DataFlow, after: DataFlow): DataFlowChange | null {
  const beforeSinks = new Map(before.sinks.map((s) => [sinkKey(s), s]))
  const afterSinks = new Map(after.sinks.map((s) => [sinkKey(s), s]))
  const sinksAdded: DataFlowSink[] = []
  const sinksRemoved: DataFlowSink[] = []
  for (const [k, s] of afterSinks) if (!beforeSinks.has(k)) sinksAdded.push(s)
  for (const [k, s] of beforeSinks) if (!afterSinks.has(k)) sinksRemoved.push(s)

  const stepsChanged = before.steps.length !== after.steps.length
  const unchanged = sinksAdded.length === 0 && sinksRemoved.length === 0 && !stepsChanged
  if (unchanged) return null

  sinksAdded.sort((a, b) => (sinkKey(a) < sinkKey(b) ? -1 : sinkKey(a) > sinkKey(b) ? 1 : 0))
  sinksRemoved.sort((a, b) => (sinkKey(a) < sinkKey(b) ? -1 : sinkKey(a) > sinkKey(b) ? 1 : 0))

  return {
    entryId: after.entry.id,
    entryKind: after.entry.kind,
    file: after.entry.file,
    sinksAdded,
    sinksRemoved,
    stepCountBefore: before.steps.length,
    stepCountAfter: after.steps.length,
  }
}

export function diffDataFlows(before: GraphSnapshot, after: GraphSnapshot): DataFlowsDiff {
  const beforeMap = new Map((before.dataFlows ?? []).map((f) => [flowKey(f), f]))
  const afterMap = new Map((after.dataFlows ?? []).map((f) => [flowKey(f), f]))

  const added = []
  const changed: DataFlowChange[] = []
  for (const [key, afterFlow] of afterMap) {
    const prev = beforeMap.get(key)
    if (prev === undefined) {
      added.push(afterFlow.entry)
      continue
    }
    const delta = diffFlow(prev, afterFlow)
    if (delta) changed.push(delta)
  }

  const removed = []
  for (const [key, beforeFlow] of beforeMap) {
    if (!afterMap.has(key)) removed.push(beforeFlow.entry)
  }

  const byEntry = <T extends { kind: string; id: string }>(a: T, b: T): number => {
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  }
  added.sort(byEntry)
  removed.sort(byEntry)
  changed.sort((a, b) => {
    if (a.entryKind !== b.entryKind) return a.entryKind < b.entryKind ? -1 : 1
    return a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0
  })

  return { added, removed, changed }
}
