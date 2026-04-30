/**
 * CyclesDetector — section 5e de analyze() migrée.
 *
 * Tarjan SCC sur graphe combiné (import + event + queue + dynamic-load).
 * Lit `ctx.graph.getAllEdges()` — graph doit être complet (toujours le
 * cas car build phase tourne avant runAll).
 *
 * Pas factsOnly-eligible. Désactivable via
 * `config.detectorOptions.cycles.enabled = false`.
 */

import type { Detector, DetectorRunContext } from '../detector-registry.js'
import { analyzeCycles } from '../../extractors/cycles.js'
import type { Cycle } from '../types.js'
import { allCycles as incAllCycles } from '../../incremental/cycles.js'
import { graphEdgesInput as incGraphEdges } from '../../incremental/truth-points.js'
import { setInputIfChanged as incSetInputIfChanged } from '../../incremental/queries.js'

export class CyclesDetector implements Detector<Cycle[]> {
  readonly name = 'cycles'
  readonly factsOnlyEligible = false

  async run(ctx: DetectorRunContext): Promise<Cycle[] | undefined> {
    const enabled =
      (ctx.config.detectorOptions?.['cycles']?.['enabled'] as boolean | undefined) ?? true
    if (!enabled) return undefined

    const opts = ctx.config.detectorOptions?.['cycles'] ?? {}
    if (ctx.options.incremental) {
      // graphEdgesInput est partagé avec truth-points (les deux derived
      // queries en dépendent). Set ici si pas déjà fait par truth-points.
      if (!incGraphEdges.has('all')) {
        incSetInputIfChanged(incGraphEdges, 'all', ctx.graph.getAllEdges())
      }
      return incAllCycles.get('all')
    }
    return await analyzeCycles(
      ctx.config.rootDir,
      ctx.files,
      ctx.graph.getAllEdges(),
      ctx.sharedProject,
      {
        edgeTypes: opts['edgeTypes'] as any,
        gateNames: opts['gateNames'] as string[] | undefined,
      },
    )
  }
}
