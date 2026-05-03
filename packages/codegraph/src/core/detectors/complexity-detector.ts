// ADR-008
/**
 * ComplexityDetector — section 5b de analyze() migrée.
 *
 * Cyclomatic complexity par fonction. Résultats mergés dans
 * `ctx.graph.setNodeMeta` — pas de patch snapshot post-run.
 *
 * Pas factsOnly-eligible (skip en factsOnly).
 */

import type { Detector, DetectorRunContext } from '../detector-registry.js'
import { analyzeComplexity } from '../../extractors/complexity.js'
import { allComplexity as incAllComplexity } from '../../incremental/complexity.js'

export class ComplexityDetector implements Detector<void> {
  readonly name = 'complexity'
  readonly factsOnlyEligible = false

  async run(ctx: DetectorRunContext): Promise<void> {
    const complexityInfos = ctx.options.incremental
      ? incAllComplexity.get('all')
      : await analyzeComplexity(
          ctx.config.rootDir,
          ctx.files,
          ctx.tsConfigPath,
          ctx.sharedProject,
        )

    for (const info of complexityInfos) {
      ctx.graph.setNodeMeta(info.file, {
        complexity: {
          topFunctions: info.topFunctions,
          maxComplexity: info.maxComplexity,
          avgComplexity: info.avgComplexity,
          totalFunctions: info.totalFunctions,
        },
      })
    }
  }
}
