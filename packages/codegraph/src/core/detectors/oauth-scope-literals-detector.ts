// ADR-008
/**
 * OauthScopeLiteralsDetector — premier détecteur migré au pattern
 * Detector/Registry (Phase A du refactor analyzer.ts).
 *
 * Encapsule la section 5k-ter de analyze() : détection de strings de
 * scope OAuth hardcodées (cf. ADR-014 Sentinel). Logique 1:1 avec le
 * code legacy — parité bit-pour-bit attendue.
 *
 * Pourquoi ce détecteur en premier :
 *   - Pure string scan, aucune dépendance inter-détecteurs
 *   - Source canonique pour les facts Datalog (factsOnly-eligible)
 *   - Path Salsa déjà branché (incremental mode)
 *   - Petit (~30 LOC dans analyze()) — itération rapide pour valider
 *     le pattern avant de migrer les gros (truth-points, data-flows).
 */

import type { Detector, DetectorRunContext } from '../detector-registry.js'
import {
  analyzeOauthScopeLiterals,
  type OauthScopeLiteral,
} from '../../extractors/oauth-scope-literals.js'
import { allOauthScopeLiterals as incAllOauthScopeLiterals } from '../../incremental/oauth-scope-literals.js'

export class OauthScopeLiteralsDetector implements Detector<OauthScopeLiteral[]> {
  readonly name = 'oauth-scope-literals'
  readonly factsOnlyEligible = true

  async run(ctx: DetectorRunContext): Promise<OauthScopeLiteral[] | undefined> {
    const enabled =
      (ctx.config.detectorOptions?.['oauthScopeLiterals']?.['enabled'] as boolean | undefined) ?? true
    if (!enabled) return undefined

    if (ctx.options.incremental) {
      // Salsa path : pure string scan, encore plus simple à cacher.
      // `scopePattern` custom non supporté ici (default suffit pour
      // Sentinel ADR-014).
      return incAllOauthScopeLiterals.get('all')
    }

    const opts = ctx.config.detectorOptions?.['oauthScopeLiterals'] ?? {}
    return await analyzeOauthScopeLiterals(
      ctx.config.rootDir,
      ctx.files,
      ctx.sharedProject,
      {
        scopePattern: opts['scopePattern'] as RegExp | undefined,
      },
    )
  }
}
