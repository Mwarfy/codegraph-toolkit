/**
 * StateMachinesDetector — section 5h de analyze() migrée.
 *
 * Enums + type aliases avec suffixe *Status|*State|*Phase|*Stage + writes
 * (SQL SET / INSERT VALUES + object literals) + trigger.
 *
 * Pas factsOnly-eligible. Désactivable via
 * `config.detectorOptions.stateMachines.enabled = false`.
 *
 * En mode incremental, les SQL defaults sont set en input AVANT runAll
 * (cf. setup async dans analyze()).
 */

import type { Detector, DetectorRunContext } from '../detector-registry.js'
import { analyzeStateMachines } from '../../extractors/state-machines.js'
import type { StateMachine } from '../types.js'
import { allStateMachines as incAllStateMachines } from '../../incremental/state-machines.js'

export class StateMachinesDetector implements Detector<StateMachine[]> {
  readonly name = 'state-machines'
  readonly factsOnlyEligible = false

  async run(ctx: DetectorRunContext): Promise<StateMachine[] | undefined> {
    const enabled =
      (ctx.config.detectorOptions?.['stateMachines']?.['enabled'] as boolean | undefined) ?? true
    if (!enabled) return undefined

    if (ctx.options.incremental) {
      // Salsa path : bundle per-file cached + agrégat global.
      // suffixes/listenFnNames custom non supportés (defaults).
      return incAllStateMachines.get('all')
    }
    const opts = ctx.config.detectorOptions?.['stateMachines'] ?? {}
    return await analyzeStateMachines(
      ctx.config.rootDir,
      ctx.files,
      ctx.sharedProject,
      {
        suffixes: opts['suffixes'] as string[] | undefined,
        listenFnNames: opts['listenFnNames'] as string[] | undefined,
      },
    )
  }
}
