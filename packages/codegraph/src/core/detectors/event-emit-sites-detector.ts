// ADR-008
/**
 * EventEmitSitesDetector — section 5k-bis de analyze() migrée.
 *
 * Classification AST des appels `emit({ type: ... })` (literal vs eventConstRef
 * vs dynamic). Source des facts Datalog `EmitsEventLiteral` / `EmitsEventConst`
 * pour les invariants ADR-017-style. factsOnly-eligible.
 *
 * Pas de dépendance inter-détecteurs (pure scan AST sur sharedProject).
 */

import type { Detector, DetectorRunContext } from '../detector-registry.js'
import {
  analyzeEventEmitSites,
  type EventEmitSite,
} from '../../extractors/event-emit-sites.js'
import { allEventEmitSites as incAllEventEmitSites } from '../../incremental/event-emit-sites.js'

export class EventEmitSitesDetector implements Detector<EventEmitSite[]> {
  readonly name = 'event-emit-sites'
  readonly factsOnlyEligible = true

  async run(ctx: DetectorRunContext): Promise<EventEmitSite[] | undefined> {
    const enabled =
      (ctx.config.detectorOptions?.['eventEmitSites']?.['enabled'] as boolean | undefined) ?? true
    if (!enabled) return undefined

    if (ctx.options.incremental) {
      // Salsa path : scan AST par fichier cached. emitFnNames custom non
      // supporté ici (Sentinel n'override jamais).
      return incAllEventEmitSites.get('all')
    }

    const opts = ctx.config.detectorOptions?.['eventEmitSites'] ?? {}
    return await analyzeEventEmitSites(
      ctx.config.rootDir,
      ctx.files,
      ctx.sharedProject,
      {
        emitFnNames: opts['emitFnNames'] as string[] | undefined,
      },
    )
  }
}
