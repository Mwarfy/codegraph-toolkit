/**
 * PackageDepsDetector — section 5j de analyze() migrée.
 *
 * `package.json` declared vs observed imports → declared-unused / missing /
 * devOnly. Multi-manifest (chaque package.json découvert = scope propre).
 * Pas factsOnly-eligible (skip en factsOnly).
 *
 * NB : en mode incremental, les manifests sont déjà set en input Salsa
 * AVANT runAll() (cf. section 4 de analyze() pour le setup async). Le
 * détecteur appelle juste `incAllPackageDeps.get('all')` qui lit l'input
 * + agrège.
 */

import type { Detector, DetectorRunContext } from '../detector-registry.js'
import { analyzePackageDeps } from '../../extractors/package-deps.js'
import type { PackageDepsIssue } from '../types.js'
import { allPackageDeps as incAllPackageDeps } from '../../incremental/package-deps.js'

export class PackageDepsDetector implements Detector<PackageDepsIssue[]> {
  readonly name = 'package-deps'
  readonly factsOnlyEligible = false

  async run(ctx: DetectorRunContext): Promise<PackageDepsIssue[] | undefined> {
    const enabled =
      (ctx.config.detectorOptions?.['packageDeps']?.['enabled'] as boolean | undefined) ?? true
    if (!enabled) return undefined

    if (ctx.options.incremental) {
      // Salsa path : packageRefsOfFile cached per-file via fileContent.
      // L'agrégat dépend aussi de packageManifestsInput (set en pre-Phase
      // dans analyze() après discovery async).
      return incAllPackageDeps.get('all')
    }

    const opts = ctx.config.detectorOptions?.['packageDeps'] ?? {}
    return await analyzePackageDeps(
      ctx.config.rootDir,
      ctx.files,
      ctx.sharedProject,
      {
        testPatterns: opts['testPatterns'] as RegExp[] | undefined,
      },
    )
  }
}
