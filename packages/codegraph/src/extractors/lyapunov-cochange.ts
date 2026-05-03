/**
 * Co-change cascade score — heuristique INSPIRÉE par Lyapunov,
 * **pas un véritable exposant de Lyapunov**.
 *
 * ⚠ HONESTY DISCLAIMER : le vrai exposant de Lyapunov d'un système
 * dynamique est λ = lim (1/t) log(|δ(t)|/|δ(0)|) où δ(t) mesure la
 * divergence de 2 trajectoires initialement proches dans un système
 * d'évolution défini. Ici nous N'AVONS NI :
 *   - système dynamique formel (juste des commits git successifs),
 *   - trajectoires (juste des sets de fichiers modifiés par commit),
 *   - mesure de séparation (juste un compte de co-changes).
 *
 * Ce que l'extracteur calcule réellement :
 *   score = log(avg(co_change_count) + 1)
 *
 * C'est une moyenne géométrique du fan-out de co-modification. Le
 * nom historique "lyapunov" est conservé pour compatibilité backward
 * mais le concept porté est "co-change cascade volatility", pas
 * Lyapunov.
 *
 * Utilité pratique (l'heuristique signal) :
 *   - score > 2 : fichier dont les modifs corrèlent avec ≥ 7 autres
 *     fichiers dans les commits passés — candidat refactor cross-cutting.
 *   - score < 1 : fichier isolé, modifs locales.
 *
 * Source : utilise CoChange facts existants.
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
