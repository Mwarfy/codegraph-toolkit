/**
 * Règle `typed-calls-coverage` — phase 2 du PLAN.md, règle #5.
 *
 * Couverture typed-calls = nombre de signatures extraites / nombre de
 * fichiers analysés. Une baisse significative peut indiquer :
 *   - une régression de l'extracteur (cas autrefois géré, maintenant raté),
 *   - un grand refactor qui perd des exports typés,
 *   - une annotation any/unknown envahissante.
 *
 * Règle default en `warn` — on ne bloque pas le commit, on remonte
 * l'information. Le seuil est une **baisse relative** du ratio
 * signatures/fichier : on alerte si `after` a perdu plus de
 * `MIN_RELATIVE_DROP` (10 % par défaut) par rapport à `before`.
 *
 * Choix relatif (vs absolu) : robuste à la taille du projet. Sentinel
 * tourne à ~2.4 sigs/fichier. Une baisse absolue de 0.5 est énorme en
 * relatif (~20 %) mais serait invisible sous un seuil fixe à 5 pts.
 */

import type { GraphSnapshot } from '../../core/types.js'
import type { CheckRule, Violation } from '../types.js'

const MIN_RELATIVE_DROP = 0.1  // 10 % de baisse du ratio signatures/fichier

export const typedCallsCoverageRule: CheckRule = {
  name: 'typed-calls-coverage',
  defaultSeverity: 'warn',
  description:
    'Couverture typed-calls (signatures/fichier) ne doit pas régresser significativement.',

  run(before: GraphSnapshot, after: GraphSnapshot): Violation[] {
    const beforeStats = coverageStats(before)
    const afterStats = coverageStats(after)

    if (beforeStats === null || afterStats === null) return []
    if (beforeStats.files === 0 || afterStats.files === 0) return []

    const beforeRatio = beforeStats.sigs / beforeStats.files
    if (beforeRatio === 0) return []  // pas de baseline signifiante

    const afterRatio = afterStats.sigs / afterStats.files
    const relativeDrop = (beforeRatio - afterRatio) / beforeRatio

    if (relativeDrop < MIN_RELATIVE_DROP) return []

    const dropPct = (relativeDrop * 100).toFixed(1)
    return [{
      rule: 'typed-calls-coverage',
      severity: 'warn',
      message:
        `Couverture typed-calls en baisse : ${beforeRatio.toFixed(2)} → ${afterRatio.toFixed(2)} ` +
        `sigs/fichier (−${dropPct}%).`,
      detail: {
        beforeSignatures: beforeStats.sigs,
        beforeFiles: beforeStats.files,
        afterSignatures: afterStats.sigs,
        afterFiles: afterStats.files,
        relativeDrop: Number(relativeDrop.toFixed(4)),
      },
    }]
  },
}

function coverageStats(snapshot: GraphSnapshot): { sigs: number; files: number } | null {
  if (!snapshot.typedCalls) return null
  return {
    sigs: snapshot.typedCalls.signatures.length,
    files: snapshot.stats.totalFiles,
  }
}
