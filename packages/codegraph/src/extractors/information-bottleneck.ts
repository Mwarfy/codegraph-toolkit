/**
 * Fan-in × fan-out chokepoint score — heuristique INSPIRÉE par
 * Information Bottleneck (Tishby/Pereira/Bialek 1999), **pas le vrai
 * Information Bottleneck**.
 *
 * ⚠ HONESTY DISCLAIMER : Le vrai Information Bottleneck calcule
 * l'information mutuelle I(X; Z) sous la contrainte I(X; Y) ≤ ε,
 * en optimisant un Lagrangien L = I(X; Z) − β·I(Z; Y). Cela
 * demande :
 *   - distributions de probabilité jointe P(X, Y),
 *   - calcul de mutual information via somme sur états ×log(p/q),
 *   - itération sur β (annealing trade-off).
 *
 * Aucune de ces 3 conditions n'est implémentée ici. L'extracteur
 * calcule un score scalaire trivial :
 *
 *   chokepointScore = log₂(callerCount + 1) × log₂(calleeCount + 1)
 *
 * C'est un PRODUIT de fan-in et fan-out passé au log. Ce n'est PAS
 * de la mutual information. Le nom "InformationBottleneck" est
 * conservé pour compatibilité backward, mais le concept réel est
 * "log-product chokepoint score".
 *
 * Utilité pratique (l'heuristique signal) :
 *   - score 1×1=0 : fn passe-plat (1 caller, 1 callee) → candidate inline
 *   - score modéré (~9) : fonction utility normale
 *   - score haut (>30) : node très connecté (caller diversity + callee
 *     diversity haute) → candidat extension point ou refactor
 *
 * Cohabite avec PageRank (centralité globale) et Shannon entropy
 * (diversité de callees) — les 3 mesurent différentes facettes du
 * couplage, pas la mutual information de Tishby.
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
