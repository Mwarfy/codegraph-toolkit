/**
 * Règle `no-new-non-gated-cycles` — phase 2 du PLAN.md, règle #1.
 *
 * Un cycle est identifié par `cycle.id` (hash stable du SCC, survit au
 * renommage des edges internes). Un cycle non-gated (`gated === false`)
 * qui apparaît dans `after` mais pas dans `before` est une violation.
 *
 * Cas explicitement NON-violations :
 *   - Un cycle gated qui devient non-gated (changement de régime) → traité
 *     comme nouvelle violation quand même, car c'est une régression
 *     sémantique équivalente.
 *   - Un cycle non-gated qui existait déjà → ignoré (pas une régression).
 *   - Un cycle non-gated supprimé → ignoré (amélioration).
 *
 * Le champ `cycle.id` est un hash du set de nœuds, donc un même cycle dont
 * les edges internes changent (ex: ajout d'un edge event) garde le même id.
 */

import type { GraphSnapshot } from '../../core/types.js'
import type { CheckRule, Violation } from '../types.js'

export const noNewNonGatedCyclesRule: CheckRule = {
  name: 'no-new-non-gated-cycles',
  defaultSeverity: 'error',
  description:
    'Aucun cycle non-gated ne doit apparaître qui n\'existait pas (ou existait en gated) avant.',

  run(before: GraphSnapshot, after: GraphSnapshot): Violation[] {
    const beforeCycles = before.cycles ?? []
    const afterCycles = after.cycles ?? []

    // Index by id for O(1) lookup. Un id correspond à une SCC unique.
    const beforeById = new Map(beforeCycles.map((c) => [c.id, c]))

    const violations: Violation[] = []

    for (const afterCycle of afterCycles) {
      if (afterCycle.gated) continue

      const prev = beforeById.get(afterCycle.id)
      // Nouveau cycle non-gated OU cycle qui est passé de gated à non-gated.
      if (prev === undefined || prev.gated === true) {
        const path = afterCycle.nodes.join(' → ')
        const reason = prev === undefined ? 'nouveau cycle' : 'cycle précédemment gated'
        violations.push({
          rule: 'no-new-non-gated-cycles',
          severity: 'error',
          message: `Nouveau cycle non-gated (${reason}) : ${path}`,
          detail: {
            cycleId: afterCycle.id,
            nodes: afterCycle.nodes,
            sccSize: afterCycle.sccSize,
            wasGatedBefore: prev?.gated ?? null,
          },
        })
      }
    }

    return violations
  },
}
