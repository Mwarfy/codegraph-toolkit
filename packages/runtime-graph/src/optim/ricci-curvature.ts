/**
 * Forman-Ricci curvature on graphs — détecte les bottlenecks topologiques.
 *
 * Discipline : géométrie discrète, généralisation de la courbure de
 * Riemann aux graphes (Forman 2003, applications réseau Sandhu-Georgiou
 * 2015). Pour une edge (u, v) :
 *
 *     κ(u, v) = w_e × (w_u/w_e + w_v/w_e
 *                    - Σ_{e' triangle de e} 1/√(w_e × w_e')
 *                    - Σ_{neighbours v_u, v_v} ...)
 *
 * Version simplifiée (poids unitaires, pas de triangles) :
 *
 *     κ(u, v) = 2 - deg(u) - deg(v)
 *
 * Interprétation :
 *   - κ > 0 : edge à curvature positive = "expanding" (low-degree neighbors)
 *   - κ ≈ 0 : edge plate
 *   - κ << 0 : edge à curvature négative = bottleneck topologique = "tight"
 *
 * Application au code : edges (file → file) à curvature très négative
 * = "goulets" du graphe. Ces files connectent des hubs et leur removal
 * fragmente le graphe. C'est où la complexité architecturale concentre.
 *
 * Coût : O(E) — extraction directe des degrés. Trivial.
 */

export interface RicciEdge {
  from: string
  to: string
}

export interface RicciOptions {
  edges: RicciEdge[]
  /** Top N bottlenecks à retourner (curvature la plus négative). Default 10. */
  topN?: number
}

export interface RicciCurvatureRow {
  from: string
  to: string
  curvature: number
  /** Degré du noeud `from` (out-degree) — utile pour interpréter. */
  fromOutDeg: number
  /** Degré du noeud `to` (in-degree). */
  toInDeg: number
  hint: string
}

export function computeRicciCurvature(opts: RicciOptions): RicciCurvatureRow[] {
  const topN = opts.topN ?? 10
  const outDeg = new Map<string, number>()
  const inDeg = new Map<string, number>()
  for (const e of opts.edges) {
    outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1)
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1)
  }

  const out: RicciCurvatureRow[] = []
  for (const e of opts.edges) {
    const dFrom = outDeg.get(e.from) ?? 0
    const dTo = inDeg.get(e.to) ?? 0
    // Forman simplifié : κ = 2 - deg(u) - deg(v)
    // (un edge contribue à 1 sortie u et 1 entrée v)
    const curvature = 2 - dFrom - dTo
    out.push({
      from: e.from,
      to: e.to,
      curvature,
      fromOutDeg: dFrom,
      toInDeg: dTo,
      hint: classifyCurvature(curvature, dFrom, dTo),
    })
  }
  out.sort((a, b) => a.curvature - b.curvature)
  return out.slice(0, topN)
}

function classifyCurvature(kappa: number, df: number, dt: number): string {
  if (kappa < -10) return `bottleneck topologique (κ=${kappa}) — pont entre 2 hubs (out=${df}, in=${dt})`
  if (kappa < -3) return `tight edge (κ=${kappa}) — flow concentré`
  if (kappa < 0) return `légèrement négatif (κ=${kappa}) — couplage modéré`
  return `expanding (κ=${kappa})`
}

export function renderRicciMarkdown(rows: RicciCurvatureRow[]): string {
  if (rows.length === 0) return ''
  const lines: string[] = []
  lines.push('## 🌐 Ricci curvature — bottlenecks topologiques (top négatifs)')
  lines.push('')
  for (const r of rows) {
    lines.push(`- \`${r.from}\` → \`${r.to}\` — ${r.hint}`)
  }
  return lines.join('\n')
}
