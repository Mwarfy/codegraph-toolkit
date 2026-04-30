/**
 * EnvUsageDetector — section 5i de analyze() migrée.
 *
 * Scan AST `process.env.X` / `process.env['X']` → section envUsage (readers
 * par nom, marquage secret heuristique). factsOnly-eligible : utilisé pour
 * les facts Datalog d'invariants config.
 *
 * Pas de dépendance inter-détecteurs (pure scan AST sur sharedProject).
 */

import type { Detector, DetectorRunContext } from '../detector-registry.js'
import { analyzeEnvUsage } from '../../extractors/env-usage.js'
import type { EnvVarUsage } from '../types.js'
import { allEnvUsage as incAllEnvUsage } from '../../incremental/env-usage.js'

export class EnvUsageDetector implements Detector<EnvVarUsage[]> {
  readonly name = 'env-usage'
  readonly factsOnlyEligible = true

  async run(ctx: DetectorRunContext): Promise<EnvVarUsage[] | undefined> {
    const enabled =
      (ctx.config.detectorOptions?.['envUsage']?.['enabled'] as boolean | undefined) ?? true
    if (!enabled) return undefined

    if (ctx.options.incremental) {
      // Salsa path : agrégat global, cache hit per-file si fileContent
      // n'a pas bougé. NB : `secretTokens` custom non supporté ici (default).
      // Si un consumer en a besoin, refactorer en input Salsa.
      return incAllEnvUsage.get('all')
    }

    const opts = ctx.config.detectorOptions?.['envUsage'] ?? {}
    return await analyzeEnvUsage(
      ctx.config.rootDir,
      ctx.files,
      ctx.sharedProject,
      {
        secretTokens: opts['secretTokens'] as string[] | undefined,
      },
    )
  }
}
