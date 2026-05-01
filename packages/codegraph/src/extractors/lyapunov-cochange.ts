/**
 * Lyapunov exponent approximation — théorie des systèmes dynamiques.
 *
 * Origine : en physique, l'exposant de Lyapunov mesure la divergence
 * exponentielle de trajectoires initialement proches. λ > 0 = chaos
 * deterministe (sensibilite extreme aux conditions initiales).
 *
 * Application au code : si un changement à un fichier provoque, en
 * moyenne, un changement à K fichiers correlés au commit suivant, et
 * que K^N croit exponentiellement (K > 1), le systeme est "chaotique"
 * — petite perturbation explose en cascade de modifs.
 *
 * Approximation pratique :
 *   λ_file = log(avg(co_change_count + 1)) sur les N derniers commits
 *
 * Si λ > 0 (avg > 1 file co-change par commit touchant ce file) =
 * chaos. Si λ très grand (>2) = file qui declenche cascade refactor.
 *
 * Compose avec :
 *   - PageRank : λ haut + PageRank haut = file central qui propage
 *   - CoChange : variant temporel, λ aggrege la dynamique
 *
 * Source : utilise CoChange facts existants. Pas besoin d'extracteur
 * git additionnel — la donnee est deja calculee par co-change.ts.
 */

import type { CoChangePair } from './co-change.js'

export interface LyapunovMetric {
  file: string
  /** Nombre total de co-changes observes (sum over partners). */
  totalCoChanges: number
  /** Nombre de partenaires distincts. */
  partnerCount: number
  /**
   * λ × 1000 : log(avg co-change + 1) × 1000.
   *   λ ≈ 0    → systeme stable (changements isoles)
   *   λ ≈ 1000 → log 2.7 → propagation modere (e change/commit)
   *   λ ≈ 2000 → propagation chaotique (e² change/commit)
   */
  lyapunovX1000: number
}

export function computeLyapunovMetrics(
  coChangePairs: CoChangePair[],
): LyapunovMetric[] {
  // file → list of co-change counts with partners
  const filePartners = new Map<string, number[]>()
  for (const p of coChangePairs) {
    if (!filePartners.has(p.from)) filePartners.set(p.from, [])
    filePartners.get(p.from)!.push(p.count)
    // CoChange edges are deduped (a < b), so we add to the second file too.
    if (!filePartners.has(p.to)) filePartners.set(p.to, [])
    filePartners.get(p.to)!.push(p.count)
  }

  const out: LyapunovMetric[] = []
  for (const [file, counts] of filePartners) {
    if (counts.length < 2) continue  // Pas assez d'historique pour Lyapunov
    const total = counts.reduce((a, b) => a + b, 0)
    const avg = total / counts.length
    // λ = log(avg + 1) — on évite log(0) avec +1
    const lambda = Math.log(avg + 1)
    out.push({
      file,
      totalCoChanges: total,
      partnerCount: counts.length,
      lyapunovX1000: Math.round(lambda * 1000),
    })
  }
  out.sort((a, b) => b.lyapunovX1000 - a.lyapunovX1000)
  return out
}
