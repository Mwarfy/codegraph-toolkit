/**
 * Symbol callee entropy — théorie de l'information (Shannon 1948).
 *
 * Origine : aucun analyzer ne mesure l'entropie de la distribution des
 * callees par fonction. Pourtant c'est un signal d'usage classique en
 * info theory : H(X) = -Σ p(x) log p(x).
 *
 * Application au code :
 *   - Fonction qui appelle 100 callees uniformément différents
 *     (entropie H ≈ log₂ 100 ≈ 6.6 bits) = polymorphisme dispersif
 *     ("god function" qui agit comme dispatcher)
 *   - Fonction qui appelle 1 callee 100 fois (H ≈ 0) = répétition
 *     de la même opération
 *   - Sweet spot autour de H ∈ [2, 4] bits = comportement focalisé
 *
 * Compose avec McCabe (cyclomatic) :
 *   - Cyclomatic haut + entropy haute = god dispatcher (orchestre N actions)
 *   - Cyclomatic haut + entropy basse = répétition branchée (refactor en loop)
 *   - Cyclomatic bas  + entropy haute = polymorphisme propre
 *
 * Calculé depuis SymbolCallEdge facts existants — pas de nouvel AST walk.
 */

import type { SymbolRefEdge } from '../core/types.js'

export interface SymbolEntropyMetric {
  /** "file:symbolName" */
  fromSymbol: string
  /** Nombre total d'appels sortants. */
  callCount: number
  /** Nombre de callees distincts. */
  distinctCallees: number
  /**
   * Entropie de Shannon × 1000 (int Datalog).
   *   0       = appelle toujours le même callee
   *   ~1000   = ~1 bit (binary choice)
   *   ~6000   = ~64 callees uniformes (god dispatcher)
   */
  entropyX1000: number
}

export function computeSymbolEntropy(
  refs: SymbolRefEdge[],
): SymbolEntropyMetric[] {
  // Group : fromSymbol → Map<toSymbol, count>
  const dist = new Map<string, Map<string, number>>()
  for (const r of refs) {
    if (!dist.has(r.from)) dist.set(r.from, new Map())
    const m = dist.get(r.from)!
    m.set(r.to, (m.get(r.to) ?? 0) + 1)
  }

  const out: SymbolEntropyMetric[] = []
  for (const [from, calleeMap] of dist) {
    const counts = [...calleeMap.values()]
    const total = counts.reduce((a, b) => a + b, 0)
    if (total < 3) continue  // Trop peu d'appels pour entropie significative
    let H = 0
    for (const c of counts) {
      const p = c / total
      if (p > 0) H -= p * Math.log2(p)
    }
    out.push({
      fromSymbol: from,
      callCount: total,
      distinctCallees: counts.length,
      entropyX1000: Math.round(H * 1000),
    })
  }
  out.sort((a, b) => b.entropyX1000 - a.entropyX1000)
  return out
}
