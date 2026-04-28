/**
 * Règle `no-new-cacheless-truthpoints` — phase 2 du PLAN.md, règle #4.
 *
 * Un truth-point sans `canonical` = un concept qui vit uniquement dans
 * un mirror (Redis, cache memory) sans table persistée. Signal fort :
 *   - soit la table existe mais n'a pas été détectée (pb d'extracteur),
 *   - soit la donnée n'a vraiment pas de persistance canonique (souvent
 *     non voulu).
 *
 * On émet une violation par nouveau concept cacheless — c'est-à-dire un
 * concept qui n'existait pas avant, OU qui existait avec canonical et
 * le perd.
 *
 * Un concept est "présent" dans un snapshot s'il a au moins un mirror
 * OU writer OU reader (les concepts détectés via table seule sans
 * aucune interaction sont rares mais possibles — ils sont également
 * inclus pour traçabilité).
 */

import type { GraphSnapshot, TruthPoint } from '../../core/types.js'
import type { CheckRule, Violation } from '../types.js'

export const noNewCachelessTruthPointsRule: CheckRule = {
  name: 'no-new-cacheless-truthpoints',
  defaultSeverity: 'error',
  description:
    'Aucun nouveau concept de donnée ne doit apparaître en cache/memory sans table canonique.',

  run(before: GraphSnapshot, after: GraphSnapshot): Violation[] {
    const beforeById = indexByConcept(before.truthPoints ?? [])
    const afterList = after.truthPoints ?? []

    const violations: Violation[] = []
    for (const tp of afterList) {
      if (tp.canonical) continue  // a une source canonique → OK
      // Seuls les concepts "vivants" (au moins un mirror) sont signalés :
      // un concept sans canonical et sans mirror est souvent un faux
      // positif d'extracteur (table qui n'existe pas réellement).
      if (tp.mirrors.length === 0) continue

      const prev = beforeById.get(tp.concept)
      const isNew = prev === undefined
      const lostCanonical = prev !== undefined && prev.canonical !== undefined

      if (isNew || lostCanonical) {
        const mirrorKinds = [...new Set(tp.mirrors.map((m) => m.kind))].sort().join('+')
        const reason = isNew
          ? `nouveau concept cacheless (${mirrorKinds})`
          : `table canonique perdue (reste ${mirrorKinds})`
        violations.push({
          rule: 'no-new-cacheless-truthpoints',
          severity: 'error',
          message: `Truth-point \`${tp.concept}\` sans canonical : ${reason}.`,
          detail: {
            concept: tp.concept,
            mirrorKinds: [...new Set(tp.mirrors.map((m) => m.kind))],
            writerCount: tp.writers.length,
            readerCount: tp.readers.length,
            wasCanonicalBefore: prev?.canonical?.name ?? null,
          },
        })
      }
    }

    return violations
  },
}

function indexByConcept(list: TruthPoint[]): Map<string, TruthPoint> {
  const out = new Map<string, TruthPoint>()
  for (const tp of list) out.set(tp.concept, tp)
  return out
}
