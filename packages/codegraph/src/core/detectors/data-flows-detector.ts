// ADR-008
/**
 * DataFlowsDetector — section 5g de analyze() migrée.
 *
 * Trajectoires entry-point → sinks via BFS sur typedCalls. Dépend de
 * typed-calls (lit `ctx.results['typed-calls']`). Si typed-calls a été
 * skip ou désactivé, data-flows skip aussi.
 *
 * Pas factsOnly-eligible. Désactivable via
 * `config.detectorOptions.dataFlows.enabled = false`.
 */

import type { Detector, DetectorRunContext } from '../detector-registry.js'
import { analyzeDataFlows } from '../../extractors/data-flows.js'
import type { DataFlow, TypedCalls } from '../types.js'
import {
  allDataFlows as incAllDataFlows,
  typedCallsInput as incTypedCallsInput,
} from '../../incremental/data-flows.js'
import { setInputIfChanged as incSetInputIfChanged } from '../../incremental/queries.js'

export class DataFlowsDetector implements Detector<DataFlow[]> {
  readonly name = 'data-flows'
  readonly factsOnlyEligible = false

  async run(ctx: DetectorRunContext): Promise<DataFlow[] | undefined> {
    const enabled =
      (ctx.config.detectorOptions?.['dataFlows']?.['enabled'] as boolean | undefined) ?? true
    if (!enabled) return undefined

    const typedCalls = ctx.results['typed-calls'] as TypedCalls | undefined
    if (!typedCalls) return undefined // typed-calls disabled / failed

    const opts = ctx.config.detectorOptions?.['dataFlows'] ?? {}
    if (ctx.options.incremental) {
      // Salsa path : alimente typedCallsInput puis appelle allDataFlows.
      incSetInputIfChanged(incTypedCallsInput, 'all', typedCalls)
      return incAllDataFlows.get('all')
    }
    return await analyzeDataFlows(
      ctx.config.rootDir,
      ctx.files,
      ctx.sharedProject,
      typedCalls,
      ctx.graph.getAllEdges(),
      {
        maxDepth: opts['maxDepth'] as number | undefined,
        downstreamDepth: opts['downstreamDepth'] as number | undefined,
        queryFnNames: opts['queryFnNames'] as string[] | undefined,
        emitFnNames: opts['emitFnNames'] as string[] | undefined,
        listenFnNames: opts['listenFnNames'] as string[] | undefined,
        httpResponseFnNames: opts['httpResponseFnNames'] as string[] | undefined,
        bullmqEnqueueFnNames: opts['bullmqEnqueueFnNames'] as string[] | undefined,
        mcpToolsPathFragment: opts['mcpToolsPathFragment'] as string | undefined,
      },
    )
  }
}
