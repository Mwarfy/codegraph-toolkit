/**
 * TypedCallsDetector — section 5d de analyze() migrée.
 *
 * Signatures d'exports + call edges avec types aux sites d'appel. Fondation
 * des extracteurs aval (data-flows, cycles, FSM, truth-points).
 *
 * Pas factsOnly-eligible (skip en factsOnly). Désactivable via
 * `config.detectorOptions.typedCalls.enabled = false`.
 */

import type { Detector, DetectorRunContext } from '../detector-registry.js'
import { analyzeTypedCalls } from '../../extractors/typed-calls.js'
import type { TypedCalls } from '../types.js'
import { allTypedCalls as incAllTypedCalls } from '../../incremental/typed-calls.js'

export class TypedCallsDetector implements Detector<TypedCalls> {
  readonly name = 'typed-calls'
  readonly factsOnlyEligible = false

  async run(ctx: DetectorRunContext): Promise<TypedCalls | undefined> {
    const enabled =
      (ctx.config.detectorOptions?.['typedCalls']?.['enabled'] as boolean | undefined) ?? true
    if (!enabled) return undefined

    return ctx.options.incremental
      ? incAllTypedCalls.get('all')
      : await analyzeTypedCalls(ctx.config.rootDir, ctx.files, ctx.sharedProject)
  }
}
