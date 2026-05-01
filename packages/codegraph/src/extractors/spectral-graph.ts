/**
 * Spectral graph theory metrics — λ₂ (Fiedler) + Cheeger bound.
 *
 * Origine : aucun analyzer TS/JS du marché ne calcule la connectivité
 * algébrique. C'est pourtant un invariant fondamental de la théorie
 * spectrale des graphes (Fiedler 1973).
 *
 * λ₂ (algebraic connectivity, second smallest eigenvalue of the
 * graph Laplacian L = D - A) capture :
 *   - Si λ₂ → 0 : le graphe est presque déconnecté (bottleneck quasi-cut)
 *   - Si λ₂ grand : graphe bien connecté, robuste
 *
 * Cheeger inequality : λ₂/2 ≤ h(G) ≤ √(2λ₂) où h(G) est le constant
 * isoperimétrique. λ₂ donne donc une borne sur le minimum cut.
 *
 * Application au code :
 *   - λ₂ très bas sur un module : signal de quasi-déconnexion = clusters
 *     mal connectés (frontières artificielles)
 *   - λ₂ très haut sur un sous-graphe : couplage excessif (monolithe latent)
 *
 * Cette mesure complete PageRank (centrality) et community-detection
 * (modularity) avec un signal orthogonal : la "facilité de séparation".
 *
 * Approximation : on calcule λ₂ via power iteration sur le Laplacien
 * normalisé (Lanczos serait plus précis mais 30 lignes vs 80).
 * Suffisant pour un signal binarisé "highly-connected vs split-friendly".
 */

import type { GraphNode, GraphEdge } from '../core/types.js'

export interface SpectralMetric {
  /** Sous-graphe (typiquement = packageName / dossier 'kernel' / etc.) */
  scope: string
  /** Nb de nodes inclus dans le sous-graphe. */
  nodeCount: number
  /** Nb d'edges du sous-graphe (interne uniquement). */
  edgeCount: number
  /**
   * Algebraic connectivity (Fiedler value), λ₂ du Laplacien normalisé.
   * Échelle [0, 2] sur Laplacien normalisé.
   *   ~ 0       : sous-graphe presque déconnecté (split natural ?)
   *   ~ 1       : connectivité modérée
   *   ~ 2       : sous-graphe très dense (monolithe latent)
   * × 1000 pour rester en int Datalog.
   */
  fiedlerX1000: number
  /**
   * Borne supérieure de Cheeger sur le min-cut normalisé.
   * h(G) ≤ √(2λ₂). Plus petit = plus facile à couper.
   */
  cheegerBound: number
}

/**
 * Power iteration pour extraire λ₂. Variante : projeter à chaque
 * iteration pour rester orthogonal à v₁ (vecteur propre principal).
 */
function fiedlerEigenvalue(adjacency: number[][]): number {
  const n = adjacency.length
  if (n < 2) return 0

  // Construit le Laplacien L = D - A
  const L: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  for (let i = 0; i < n; i++) {
    let degree = 0
    for (let j = 0; j < n; j++) {
      if (i !== j && adjacency[i][j] > 0) {
        L[i][j] = -1
        degree++
      }
    }
    L[i][i] = degree
  }

  // Power iteration sur L, projection orthogonale à v₁ = (1,1,...,1)/√n
  // (vecteur propre trivial pour λ₁ = 0).
  let v = new Array<number>(n).fill(0).map(() => Math.random() - 0.5)
  for (let iter = 0; iter < 200; iter++) {
    // Project out v₁ (constant vector)
    const mean = v.reduce((a, b) => a + b, 0) / n
    v = v.map((x) => x - mean)
    // Normalize
    const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0))
    if (norm < 1e-12) break
    v = v.map((x) => x / norm)
    // Apply L
    const Lv = new Array<number>(n).fill(0)
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) Lv[i] += L[i][j] * v[j]
    }
    v = Lv
  }
  // λ₂ ≈ v^T L v / v^T v after convergence (Rayleigh quotient).
  let num = 0, den = 0
  const Lv = new Array<number>(n).fill(0)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) Lv[i] += L[i][j] * v[j]
  }
  for (let i = 0; i < n; i++) { num += v[i] * Lv[i]; den += v[i] * v[i] }
  return den > 0 ? num / den : 0
}

/**
 * Compute λ₂ pour les sous-graphes par "scope" (premier 3 segments du path).
 * Ex: packages/codegraph/src/extractors/* forme un scope.
 */
export function computeSpectralMetrics(
  nodes: GraphNode[],
  edges: GraphEdge[],
): SpectralMetric[] {
  const fileNodes = nodes.filter((n) => n.type === 'file')
  const fileSet = new Set(fileNodes.map((n) => n.id))

  // Group files by scope (3 path segments)
  const scopeOf = (path: string): string => {
    const parts = path.split('/')
    return parts.slice(0, Math.min(3, parts.length)).join('/')
  }
  const scopeFiles = new Map<string, string[]>()
  for (const n of fileNodes) {
    const s = scopeOf(n.id)
    if (!scopeFiles.has(s)) scopeFiles.set(s, [])
    scopeFiles.get(s)!.push(n.id)
  }

  const out: SpectralMetric[] = []
  for (const [scope, files] of scopeFiles) {
    if (files.length < 3) continue  // λ₂ peu informatif pour <3 nodes
    if (files.length > 100) continue  // Power iteration coût O(n² × iter)
    const idx = new Map<string, number>()
    files.forEach((f, i) => idx.set(f, i))
    const n = files.length
    const adj: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0))
    let edgeCount = 0
    for (const e of edges) {
      if (e.type !== 'import') continue
      if (!fileSet.has(e.from) || !fileSet.has(e.to)) continue
      const a = idx.get(e.from)
      const b = idx.get(e.to)
      if (a === undefined || b === undefined) continue
      if (a === b) continue
      adj[a][b] = 1
      adj[b][a] = 1  // Undirected pour calcul λ₂
      edgeCount++
    }
    const lambda2 = fiedlerEigenvalue(adj)
    out.push({
      scope,
      nodeCount: n,
      edgeCount,
      fiedlerX1000: Math.round(lambda2 * 1000),
      cheegerBound: Math.round(Math.sqrt(2 * Math.max(0, lambda2)) * 1000),
    })
  }
  out.sort((a, b) => a.fiedlerX1000 - b.fiedlerX1000)
  return out
}
