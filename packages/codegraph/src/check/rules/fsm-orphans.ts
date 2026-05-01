/**
 * Règle `no-new-orphan-states` — phase 2 du PLAN.md, règle #2.
 *
 * Un état orphelin = état déclaré dans l'enum/union mais jamais écrit
 * (jamais utilisé comme `to` d'une transition). C'est un signal fort :
 *   - soit un état mort qu'il faut retirer du type,
 *   - soit du code qui devait l'écrire et qui manque.
 *
 * On compare les ensembles (concept, orphanState) avant et après. Un
 * nouveau pair = violation. Une FSM totalement nouvelle dont tous les
 * états sont orphans (ex: enum défini, logique pas encore écrite)
 * produit une violation par état — c'est voulu : au moment où la PR
 * introduit l'enum, elle devrait aussi introduire les writes.
 */

import type { GraphSnapshot } from '../../core/types.js'
import type { CheckRule, Violation } from '../types.js'
import { splitNullKey as splitKey } from '../../extractors/_shared/ast-helpers.js'

export const noNewOrphanStatesRule: CheckRule = {
  name: 'no-new-orphan-states',
  defaultSeverity: 'error',
  description:
    'Aucun nouvel état orphelin (déclaré mais jamais écrit) ne doit apparaître dans une FSM.',

  run(before: GraphSnapshot, after: GraphSnapshot): Violation[] {
    const beforeSet = orphanSet(before)
    const afterSet = orphanSet(after)

    const violations: Violation[] = []
    for (const key of [...afterSet].sort()) {
      if (!beforeSet.has(key)) {
        const [concept, state] = splitKey(key)
        violations.push({
          rule: 'no-new-orphan-states',
          severity: 'error',
          message: `Nouvel état orphelin dans FSM \`${concept}\` : \`${state}\` (déclaré mais jamais écrit).`,
          detail: { concept, state },
        })
      }
    }
    return violations
  },
}

function orphanSet(snapshot: GraphSnapshot): Set<string> {
  const out = new Set<string>()
  for (const fsm of snapshot.stateMachines ?? []) {
    for (const orphan of fsm.orphanStates) {
      out.add(`${fsm.concept}\u0000${orphan}`)
    }
  }
  return out
}

