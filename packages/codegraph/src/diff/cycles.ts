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

type CycleEntry = NonNullable<GraphSnapshot['cycles']>[number]
type GatingChange = CyclesDiff['gatingChanged'][number]

export function diffCycles(before: GraphSnapshot, after: GraphSnapshot): CyclesDiff {
  const beforeMap = new Map((before.cycles ?? []).map((c) => [c.id, c]))
  const afterMap = new Map((after.cycles ?? []).map((c) => [c.id, c]))

  const { added, gatingChanged } = scanAfterMap(beforeMap, afterMap)
  const removed = collectRemovedCycles(beforeMap, afterMap)

  added.sort(compareAddedCycle)
  removed.sort(compareById)
  gatingChanged.sort((a, b) => (a.cycleId < b.cycleId ? -1 : a.cycleId > b.cycleId ? 1 : 0))

  return { added, removed, gatingChanged }
}

/** Pour chaque cycle de `after` : added si nouveau, gating-changed si flip. */
function scanAfterMap(
  beforeMap: Map<string, CycleEntry>,
  afterMap: Map<string, CycleEntry>,
): { added: CycleEntry[]; gatingChanged: GatingChange[] } {
  const added: CycleEntry[] = []
  const gatingChanged: GatingChange[] = []
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
  return { added, gatingChanged }
}

function collectRemovedCycles(
  beforeMap: Map<string, CycleEntry>,
  afterMap: Map<string, CycleEntry>,
): CycleEntry[] {
  const removed: CycleEntry[] = []
  for (const [id, beforeCycle] of beforeMap) {
    if (!afterMap.has(id)) removed.push(beforeCycle)
  }
  return removed
}

/** Tri added : non-gated d'abord (plus urgent à voir), puis par id. */
function compareAddedCycle(a: CycleEntry, b: CycleEntry): number {
  if (a.gated !== b.gated) return a.gated ? 1 : -1
  return compareById(a, b)
}

function compareById(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
