/**
 * BarrelsDetector — section 5k de analyze() migrée.
 *
 * Fichiers 100% ré-exports → `lowValue` si consumers < threshold.
 * Pas factsOnly-eligible (skip en factsOnly).
 */

import type { Detector, DetectorRunContext } from '../detector-registry.js'
import { analyzeBarrels } from '../../extractors/barrels.js'
import type { BarrelInfo } from '../types.js'
import { allBarrels as incAllBarrels } from '../../incremental/barrels.js'

export class BarrelsDetector implements Detector<BarrelInfo[]> {
  readonly name = 'barrels'
  readonly factsOnlyEligible = false

  async run(ctx: DetectorRunContext): Promise<BarrelInfo[] | undefined> {
    const enabled =
      (ctx.config.detectorOptions?.['barrels']?.['enabled'] as boolean | undefined) ?? true
    if (!enabled) return undefined

    if (ctx.options.incremental) {
      // Salsa path : barrelInfoOfFile + importTargetsOfFile per-file,
      // agrégat global re-tourne mais lit du cache. minConsumers custom
      // non supporté ici (default 2 suffit pour Sentinel).
      return incAllBarrels.get('all')
    }

    const opts = ctx.config.detectorOptions?.['barrels'] ?? {}
    return await analyzeBarrels(
      ctx.config.rootDir,
      ctx.files,
      ctx.sharedProject,
      {
        minConsumers: opts['minConsumers'] as number | undefined,
      },
    )
  }
}
