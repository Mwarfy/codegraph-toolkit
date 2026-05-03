// ADR-008
/**
 * TruthPointsDetector — section 5f de analyze() migrée.
 *
 * Pour chaque concept de donnée partagée : canonical table + mirrors
 * (redis / memory) + writers / readers / exposed. Lit `ctx.graph.getAllEdges()`.
 *
 * Pas factsOnly-eligible. Désactivable via
 * `config.detectorOptions.truthPoints.enabled = false`.
 */

import type { Detector, DetectorRunContext } from '../detector-registry.js'
import { analyzeTruthPoints } from '../../extractors/truth-points.js'
import type { TruthPoint } from '../types.js'
import {
  allTruthPoints as incAllTruthPoints,
  graphEdgesInput as incGraphEdges,
} from '../../incremental/truth-points.js'
import { setInputIfChanged as incSetInputIfChanged } from '../../incremental/queries.js'

export class TruthPointsDetector implements Detector<TruthPoint[]> {
  readonly name = 'truth-points'
  readonly factsOnlyEligible = false

  async run(ctx: DetectorRunContext): Promise<TruthPoint[] | undefined> {
    const enabled =
      (ctx.config.detectorOptions?.['truthPoints']?.['enabled'] as boolean | undefined) ?? true
    if (!enabled) return undefined

    const opts = ctx.config.detectorOptions?.['truthPoints'] ?? {}
    if (ctx.options.incremental) {
      // Salsa path : feed graph edges + delegate to allTruthPoints.
      // conceptAliases / redisVarNames / etc. custom non supportés
      // (defaults suffisent pour Sentinel).
      incSetInputIfChanged(incGraphEdges, 'all', ctx.graph.getAllEdges())
      return incAllTruthPoints.get('all')
    }
    return await analyzeTruthPoints(
      ctx.config.rootDir,
      ctx.files,
      ctx.sharedProject,
      ctx.graph.getAllEdges(),
      {
        conceptAliases: opts['conceptAliases'] as Record<string, string[]> | undefined,
        redisVarNames: opts['redisVarNames'] as string[] | undefined,
        memoryCacheSuffixes: opts['memoryCacheSuffixes'] as string[] | undefined,
        memoryCacheCtors: opts['memoryCacheCtors'] as string[] | undefined,
        exposedPrefixes: opts['exposedPrefixes'] as string[] | undefined,
      },
    )
  }
}
