/**
 * UnusedExportsDetector — section 5 (exports) de analyze() migrée.
 *
 * Function-level granularité d'exports. En mode incremental, alimente
 * d'abord `testFilesIndexInput` (async I/O) puis lit `allUnusedExports`.
 * Mute `ctx.graph` via `setNodeExports` — pas de patch de snapshot
 * post-run.
 *
 * Pas factsOnly-eligible (skip en factsOnly).
 */

import type { Detector, DetectorRunContext } from '../detector-registry.js'
import {
  analyzeExports,
  buildTestFilesIndex,
} from '../../extractors/unused-exports.js'
import {
  allUnusedExports as incAllUnusedExports,
  testFilesIndexInput as incTestFilesIndex,
} from '../../incremental/unused-exports.js'
import { setInputIfChanged as incSetInputIfChanged } from '../../incremental/queries.js'

export class UnusedExportsDetector implements Detector<void> {
  readonly name = 'unused-exports'
  readonly factsOnlyEligible = false

  async run(ctx: DetectorRunContext): Promise<void> {
    let exportInfos
    if (ctx.options.incremental) {
      // Sprint 11.2 : route via Salsa. Set le testFilesIndex async puis
      // get l'agrégat (cached + per-file invalidation).
      const testIdx = await buildTestFilesIndex(ctx.config.rootDir)
      incSetInputIfChanged(incTestFilesIndex, 'all', testIdx)
      exportInfos = incAllUnusedExports.get('all')
    } else {
      exportInfos = await analyzeExports(
        ctx.config.rootDir,
        ctx.files,
        ctx.tsConfigPath,
        ctx.sharedProject,
      )
    }

    // Patch export data into the graph nodes
    for (const info of exportInfos) {
      const node = ctx.graph.getNodeById(info.file)
      if (node) {
        ctx.graph.setNodeExports(info.file, info.exports, info.totalCount)
      }
    }
  }
}
