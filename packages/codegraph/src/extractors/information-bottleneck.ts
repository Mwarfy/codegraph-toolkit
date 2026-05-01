/**
 * Information Bottleneck approximation — Tishby/Pereira/Bialek 1999.
 *
 * Origine : "The Information Bottleneck Method" propose une mesure de
 * la quantite d'information qu'une variable Y transmet de X vers Z.
 * I(X; Z) sous contrainte I(X; Y) <= ε.
 *
 * Application au code : chaque fonction F est un "bottleneck" entre
 * ses callers (input X) et ses callees (output Z). On approxime
 * I(callers; callees) via :
 *
 *   bottleneckScore = log₂(callerCount + 1) × log₂(calleeCount + 1)
 *
 * Cette approximation capture la "richesse" du flow d'information
 * traversant F :
 *   - score très bas (1×1=1) : fn passe-plat (1 caller, 1 callee) =
 *     candidate inline
 *   - score modéré (3×3=9) : fonction utility normale
 *   - score très haut (>30) : information hub (point de convergence
 *     puis redistribution = bon candidat extension point)
 *
 * Different de PageRank et entropy :
 *   - PageRank : centralite globale (importance dans le graphe entier)
 *   - Shannon entropy : diversite des callees (quoi appelé)
 *   - IB : largeur du transfer caller→callee (combien circule)
 *
 * Les 3 mesures cohabitent : IB peut être bas pour une fonction haute
 * en entropy (1 caller mais beaucoup de callees diverses = wrapper).
 */

import type { SymbolRefEdge } from '../core/types.js'

export interface InformationBottleneck {
  /** "file:symbolName" */
  symbol: string
  /** Nb de callers distincts. */
  callerCount: number
  /** Nb de callees distincts. */
  calleeCount: number
  /**
   * Score IB × 1000.
   *   passthrough : ~1000
   *   normal      : ~3000-9000
   *   hub         : >25000
   */
  bottleneckScoreX1000: number
}

export function computeInformationBottleneck(
  refs: SymbolRefEdge[],
): InformationBottleneck[] {
  // For each symbol, accumulate { callers: Set, callees: Set }
  const stats = new Map<string, { callers: Set<string>; callees: Set<string> }>()
  const ensure = (s: string): { callers: Set<string>; callees: Set<string> } => {
    let v = stats.get(s)
    if (!v) {
      v = { callers: new Set(), callees: new Set() }
      stats.set(s, v)
    }
    return v
  }
  for (const r of refs) {
    ensure(r.from).callees.add(r.to)
    ensure(r.to).callers.add(r.from)
  }
  const out: InformationBottleneck[] = []
  for (const [symbol, { callers, callees }] of stats) {
    if (callers.size === 0 && callees.size === 0) continue
    // log₂(n+1) shifts to handle n=0 cleanly
    const score = Math.log2(callers.size + 1) * Math.log2(callees.size + 1)
    out.push({
      symbol,
      callerCount: callers.size,
      calleeCount: callees.size,
      bottleneckScoreX1000: Math.round(score * 1000),
    })
  }
  // Sort par score asc — passthroughs en haut (les plus interessants
  // pour cleanup, vs hubs qui sont des design points)
  out.sort((a, b) => a.bottleneckScoreX1000 - b.bottleneckScoreX1000)
  return out
}
