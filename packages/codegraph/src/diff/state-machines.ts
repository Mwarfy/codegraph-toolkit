/**
 * State machines diff — phase 3 du PLAN.md.
 *
 * Matching par `concept`. Pour chaque FSM présente dans les deux
 * snapshots, on compare :
 *   - les `states` (ensemble) → statesAdded / statesRemoved
 *   - les `orphanStates` → orphansAdded / orphansResolved
 *   - les `deadStates` → deadAdded / deadResolved
 *   - les `transitions` par clé stable
 *     (trigger.kind + trigger.id + from + to + file + line)
 *
 * Une FSM dont rien ne bouge n'apparaît pas dans `changed`.
 */

import type { GraphSnapshot, StateMachine, StateTransition } from '../core/types.js'
import type { StateMachineChange, StateMachinesDiff } from './types.js'

// Matching par identité logique (phase 3.5) — la ligne est dans la
// donnée affichée mais pas dans la clé. Sinon un refactor qui déplace
// un call site de quelques lignes crée -1/+1 transitions pour la même
// logique (trigger, from, to, file inchangés).
function transitionKey(t: StateTransition): string {
  return [t.trigger.kind, t.trigger.id, t.from, t.to, t.file].join('\u0000')
}

function diffFsm(before: StateMachine, after: StateMachine): StateMachineChange | null {
  const beforeStates = new Set(before.states)
  const afterStates = new Set(after.states)
  const statesAdded = [...afterStates].filter((s) => !beforeStates.has(s)).sort()
  const statesRemoved = [...beforeStates].filter((s) => !afterStates.has(s)).sort()

  const beforeOrphans = new Set(before.orphanStates)
  const afterOrphans = new Set(after.orphanStates)
  const orphansAdded = [...afterOrphans].filter((s) => !beforeOrphans.has(s)).sort()
  const orphansResolved = [...beforeOrphans].filter((s) => !afterOrphans.has(s)).sort()

  const beforeDead = new Set(before.deadStates)
  const afterDead = new Set(after.deadStates)
  const deadAdded = [...afterDead].filter((s) => !beforeDead.has(s)).sort()
  const deadResolved = [...beforeDead].filter((s) => !afterDead.has(s)).sort()

  const beforeTransitions = new Map(before.transitions.map((t) => [transitionKey(t), t]))
  const afterTransitions = new Map(after.transitions.map((t) => [transitionKey(t), t]))
  const transitionsAdded: StateTransition[] = []
  const transitionsRemoved: StateTransition[] = []
  for (const [k, t] of afterTransitions) if (!beforeTransitions.has(k)) transitionsAdded.push(t)
  for (const [k, t] of beforeTransitions) if (!afterTransitions.has(k)) transitionsRemoved.push(t)

  const unchanged =
    statesAdded.length === 0 &&
    statesRemoved.length === 0 &&
    orphansAdded.length === 0 &&
    orphansResolved.length === 0 &&
    deadAdded.length === 0 &&
    deadResolved.length === 0 &&
    transitionsAdded.length === 0 &&
    transitionsRemoved.length === 0
  if (unchanged) return null

  // Tri stable des transitions.
  const byTrans = (a: StateTransition, b: StateTransition): number =>
    transitionKey(a) < transitionKey(b) ? -1 : transitionKey(a) > transitionKey(b) ? 1 : 0
  transitionsAdded.sort(byTrans)
  transitionsRemoved.sort(byTrans)

  return {
    concept: after.concept,
    statesAdded,
    statesRemoved,
    orphansAdded,
    orphansResolved,
    deadAdded,
    deadResolved,
    transitionsAdded,
    transitionsRemoved,
  }
}

export function diffStateMachines(before: GraphSnapshot, after: GraphSnapshot): StateMachinesDiff {
  const beforeMap = new Map((before.stateMachines ?? []).map((f) => [f.concept, f]))
  const afterMap = new Map((after.stateMachines ?? []).map((f) => [f.concept, f]))

  const added: StateMachine[] = []
  const changed: StateMachineChange[] = []
  for (const [concept, afterFsm] of afterMap) {
    const prev = beforeMap.get(concept)
    if (prev === undefined) {
      added.push(afterFsm)
      continue
    }
    const delta = diffFsm(prev, afterFsm)
    if (delta) changed.push(delta)
  }

  const removed: StateMachine[] = []
  for (const [concept, beforeFsm] of beforeMap) {
    if (!afterMap.has(concept)) removed.push(beforeFsm)
  }

  const byConcept = <T extends { concept: string }>(a: T, b: T): number =>
    a.concept < b.concept ? -1 : a.concept > b.concept ? 1 : 0
  added.sort(byConcept)
  removed.sort(byConcept)
  changed.sort(byConcept)

  return { added, removed, changed }
}
