// ADR-008
/**
 * SymbolRefsDetector — section 5c de analyze() migrée.
 *
 * Construit le graphe symbol-level (file:symbolName edges). Permet
 * PageRank symbol-level + find_references précis. Stocke `refs[]`
 * dans ctx.results['symbol-refs'] pour patcher snapshot.symbolRefs.
 *
 * Pas factsOnly-eligible (skip en factsOnly).
 */

import type { Detector, DetectorRunContext } from '../detector-registry.js'
import { analyzeSymbolRefs } from '../../extractors/symbol-refs.js'
import { allSymbolRefs as incAllSymbolRefs } from '../../incremental/symbol-refs.js'

export type SymbolRefEdge = { from: string; to: string; line: number }

export class SymbolRefsDetector implements Detector<SymbolRefEdge[]> {
  readonly name = 'symbol-refs'
  readonly factsOnlyEligible = false

  async run(ctx: DetectorRunContext): Promise<SymbolRefEdge[]> {
    const result = ctx.options.incremental
      ? incAllSymbolRefs.get('all')
      : await analyzeSymbolRefs(ctx.config.rootDir, ctx.files, ctx.sharedProject)
    return result.refs
  }
}
