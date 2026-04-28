/**
 * Cycles diff — phase 3 du PLAN.md.
 *
 * Les cycles sont identifiés par `cycle.id` (hash stable du SCC). Un
 * même SCC dont les edges internes bougent garde le même id — on ne
 * signale une modification que si le statut `gated` bascule.
 *
 * Silence volontaire : on ne signale pas les changements de `nodes[]`
 * (path extrait) ni de `sccSize`. Ce sont des signaux dérivés qui
 * bougent avec les micro-changements du graphe. L'identité du cycle
 * (le set de nœuds du SCC) est ce qui compte.
 */

import type { GraphSnapshot } from '../core/types.js'
import type { CyclesDiff } from './types.js'

export function diffCycles(before: GraphSnapshot, after: GraphSnapshot): CyclesDiff {
  const beforeMap = new Map((before.cycles ?? []).map((c) => [c.id, c]))
  const afterMap = new Map((after.cycles ?? []).map((c) => [c.id, c]))

  const added = []
  const gatingChanged = []
  for (const [id, afterCycle] of afterMap) {
    const prev = beforeMap.get(id)
    if (prev === undefined) {
      added.push(afterCycle)
    } else if (prev.gated !== afterCycle.gated) {
      gatingChanged.push({
        cycleId: id,
        nodes: afterCycle.nodes,
        wasGated: prev.gated,
        nowGated: afterCycle.gated,
      })
    }
  }

  const removed = []
  for (const [id, beforeCycle] of beforeMap) {
    if (!afterMap.has(id)) removed.push(beforeCycle)
  }

  // Tri stable : non-gated d'abord pour `added` (plus urgent à voir),
  // par id pour `removed` et `gatingChanged` (identité stable).
  added.sort((a, b) => {
    if (a.gated !== b.gated) return a.gated ? 1 : -1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  removed.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  gatingChanged.sort((a, b) => (a.cycleId < b.cycleId ? -1 : a.cycleId > b.cycleId ? 1 : 0))

  return { added, removed, gatingChanged }
}
