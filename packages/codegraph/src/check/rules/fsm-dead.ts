/**
 * Règle `no-new-dead-states` — phase 2 du PLAN.md, règle #3.
 *
 * Un état mort = état écrit (apparaît comme `to` d'au moins une
 * transition) mais qui n'a aucune transition sortante (jamais en `from`),
 * ET qui n'est pas explicitement terminal.
 *
 * Limite v1 assumée (voir PLAN.md section 1.6) : l'extracteur
 * state-machines n'a pas de notion de "terminal explicite" et toutes les
 * transitions ont généralement `from === '*'`. Résultat : `deadStates`
 * peut être bruyant. La règle reste utile au niveau **diff** : on ne
 * signale que les states qui deviennent morts, pas ceux qui l'étaient
 * déjà. Pour la version courante des extracteurs, `deadStates` sera
 * souvent vide — et c'est la règle qui nous protège contre une
 * régression future si un état se met à être écrit mais plus jamais
 * transitionné vers un autre.
 */

import type { GraphSnapshot } from '../../core/types.js'
import type { CheckRule, Violation } from '../types.js'
import { splitNullKey as splitKey } from '../../extractors/_shared/ast-helpers.js'

export const noNewDeadStatesRule: CheckRule = {
  name: 'no-new-dead-states',
  defaultSeverity: 'error',
  description:
    'Aucun nouvel état mort (écrit mais sans sortie, non terminal) ne doit apparaître dans une FSM.',

  run(before: GraphSnapshot, after: GraphSnapshot): Violation[] {
    const beforeSet = deadSet(before)
    const afterSet = deadSet(after)

    const violations: Violation[] = []
    for (const key of [...afterSet].sort()) {
      if (!beforeSet.has(key)) {
        const [concept, state] = splitKey(key)
        violations.push({
          rule: 'no-new-dead-states',
          severity: 'error',
          message: `Nouvel état mort dans FSM \`${concept}\` : \`${state}\` (écrit mais sans transition sortante).`,
          detail: { concept, state },
        })
      }
    }
    return violations
  },
}

function deadSet(snapshot: GraphSnapshot): Set<string> {
  const out = new Set<string>()
  for (const fsm of snapshot.stateMachines ?? []) {
    for (const dead of fsm.deadStates) {
      out.add(`${fsm.concept}\u0000${dead}`)
    }
  }
  return out
}
