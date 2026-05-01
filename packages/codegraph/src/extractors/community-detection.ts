/**
 * Community detection — Newman-Girvan modularity via Louvain algorithm.
 *
 * 8e discipline mathématique portée dans codegraph (après Fiedler λ₂,
 * Shannon, Hamming, TDA persistent homology, Lyapunov, Ford-Fulkerson
 * min-cut, Tishby information bottleneck).
 *
 * Origine : Newman-Girvan 2004 ("Finding and evaluating community
 * structure in networks"). Modularity Q :
 *
 *     Q = Σᵢ (eᵢᵢ - aᵢ²)
 *
 * où eᵢᵢ = fraction d'edges intra-community i, aᵢ = fraction d'edges
 * incidentes à community i. Q ∈ [-0.5, 1] ; Q > 0.3 = structure
 * communautaire claire ; Q > 0.7 = communautés très distinctes.
 *
 * Application au code : le graphe d'imports a-t-il une structure
 * modulaire NATURELLE différente du découpage en packages physiques ?
 *
 *   - Si modularity haute ET un fichier est dans une community
 *     différente de son package physique = candidat à co-localisation.
 *   - Si plusieurs fichiers traversent la même frontière package vs
 *     community = découpage architectural sous-optimal.
 *
 * Différenciation vs disciplines déjà portées :
 *   - PageRank : centralité d'UN node (pas de structure communautaire)
 *   - Fiedler λ₂ : connectivité d'UN sous-graphe DONNÉ (pas de découverte)
 *   - Min-cut : coût de séparation entre 2 ensembles DONNÉS (pas de découverte)
 *   - Newman-Girvan : DÉCOUVRE les communautés naturelles (output = partition)
 *
 * Algorithme : Louvain (Blondel et al. 2008), greedy hierarchical
 * modularity maximization. O(n log n) attendu, supporté par
 * graphology-communities-louvain.
 */

import GraphologyModule from 'graphology'
import louvainModule from 'graphology-communities-louvain'
import * as path from 'node:path'
import type { GraphNode, GraphEdge } from '../core/types.js'

// CommonJS interop : graphology ships as `.default`, louvain comme function.
const Graph = (GraphologyModule as unknown as { default?: typeof GraphologyModule }).default ?? GraphologyModule
type LouvainFn = ((g: unknown) => Record<string, number>) & {
  detailed: (g: unknown) => { modularity: number; communities: Record<string, number> }
}
const louvain = ((louvainModule as unknown as { default?: LouvainFn }).default ?? louvainModule) as LouvainFn

export interface ImportCommunity {
  /** Fichier source. */
  file: string
  /** ID de communauté Louvain (entier petit, 0..N-1). */
  communityId: number
  /** Package physique (premier 2 segments du path). */
  physicalPackage: string
  /**
   * 1 si le file est dans une community différente du package physique
   * majoritaire de cette community (= candidat à co-localisation).
   * 0 sinon.
   */
  misplaced: 0 | 1
}

export interface ModularityScore {
  /** Modularity globale Q × 1000. > 300 = structure communautaire claire. */
  globalModularityX1000: number
  /** Nombre de communautés détectées. */
  communityCount: number
  /** Nombre de fichiers misplaced (community ≠ package physique). */
  misplacedCount: number
}

/**
 * Calcule les communautés Louvain sur le graphe d'imports puis détecte
 * les fichiers "misplaced" (community ≠ package physique majoritaire).
 *
 * Retourne :
 *   - communities : par fichier, sa community + flag misplaced
 *   - score : modularity globale + stats
 */
export function computeCommunityDetection(
  nodes: GraphNode[],
  edges: GraphEdge[],
): { communities: ImportCommunity[]; score: ModularityScore } {
  if (nodes.length < 4 || edges.length < 3) {
    return {
      communities: [],
      score: { globalModularityX1000: 0, communityCount: 0, misplacedCount: 0 },
    }
  }

  // Filtre les fichiers de build (dist/*.d.ts, *.js.map, etc.) qui
  // peuvent traîner dans le snapshot mais ne sont pas du code source
  // actionnable. Sinon ils pollue les misplaced detections.
  const isSourceFile = (file: string): boolean => {
    if (file.includes('/dist/')) return false
    if (file.includes('/build/')) return false
    if (file.endsWith('.d.ts')) return false
    if (file.endsWith('.js.map') || file.endsWith('.d.ts.map')) return false
    return true
  }
  const filteredNodes = nodes.filter((n) => isSourceFile(n.id))
  const filteredEdges = edges.filter((e) => isSourceFile(e.from) && isSourceFile(e.to))
  if (filteredNodes.length < 4 || filteredEdges.length < 3) {
    return {
      communities: [],
      score: { globalModularityX1000: 0, communityCount: 0, misplacedCount: 0 },
    }
  }

  const g = new (Graph as unknown as new (opts: { type: string; allowSelfLoops: boolean }) => {
    hasNode: (id: string) => boolean
    addNode: (id: string) => void
    hasEdge: (a: string, b: string) => boolean
    addEdge: (a: string, b: string) => void
    size: number
  })({ type: 'undirected', allowSelfLoops: false })

  for (const n of filteredNodes) {
    if (!g.hasNode(n.id)) g.addNode(n.id)
  }
  for (const e of filteredEdges) {
    if (e.from === e.to) continue
    if (!g.hasNode(e.from) || !g.hasNode(e.to)) continue
    if (g.hasEdge(e.from, e.to) || g.hasEdge(e.to, e.from)) continue
    g.addEdge(e.from, e.to)
  }

  if (g.size === 0) {
    return {
      communities: [],
      score: { globalModularityX1000: 0, communityCount: 0, misplacedCount: 0 },
    }
  }

  // Louvain : retourne un mapping nodeId → communityId
  const partition = louvain(g)
  const modularity = louvain.detailed(g).modularity

  // Détecte le package physique majoritaire de chaque community
  const physicalPackageOf = (file: string): string => {
    const parts = file.split(path.sep).filter(Boolean)
    // Heuristique : packages/<X>/src/... → "packages/<X>"
    // packages/<X>/src ou apps/<X>/... → "<top>/<sub>"
    if (parts[0] === 'packages' && parts.length > 1) return `packages/${parts[1]}`
    if (parts[0] === 'apps' && parts.length > 1) return `apps/${parts[1]}`
    if (parts[0] === 'sentinel-core' || parts[0] === 'sentinel-web') return parts[0]
    // Fallback : 2 premiers segments
    return parts.slice(0, 2).join('/')
  }

  const communityToPackage: Map<number, Map<string, number>> = new Map()
  for (const file of Object.keys(partition)) {
    const cid = partition[file] as number
    const pkg = physicalPackageOf(file)
    if (!communityToPackage.has(cid)) communityToPackage.set(cid, new Map())
    const pkgCount = communityToPackage.get(cid)!
    pkgCount.set(pkg, (pkgCount.get(pkg) ?? 0) + 1)
  }

  // Pour chaque community, le package majoritaire
  const dominantPackageOf: Map<number, string> = new Map()
  for (const [cid, pkgCount] of communityToPackage) {
    let maxPkg = ''
    let maxN = 0
    for (const [pkg, n] of pkgCount) {
      if (n > maxN) {
        maxN = n
        maxPkg = pkg
      }
    }
    dominantPackageOf.set(cid, maxPkg)
  }

  const communities: ImportCommunity[] = []
  let misplacedCount = 0
  for (const file of Object.keys(partition).sort()) {
    const cid = partition[file] as number
    const physicalPkg = physicalPackageOf(file)
    const dominantPkg = dominantPackageOf.get(cid) ?? ''
    const misplaced: 0 | 1 = physicalPkg !== dominantPkg ? 1 : 0
    if (misplaced) misplacedCount++
    communities.push({
      file,
      communityId: cid,
      physicalPackage: physicalPkg,
      misplaced,
    })
  }

  const communityCount = new Set(Object.values(partition)).size
  const globalModularityX1000 = Math.round(modularity * 1000)

  return {
    communities,
    score: { globalModularityX1000, communityCount, misplacedCount },
  }
}
