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
type LouvainOptions = { rng?: () => number; randomWalk?: boolean; resolution?: number }
type LouvainFn = ((g: unknown, opts?: LouvainOptions) => Record<string, number>) & {
  detailed: (g: unknown, opts?: LouvainOptions) => { modularity: number; communities: Record<string, number> }
}
const louvain = ((louvainModule as unknown as { default?: LouvainFn }).default ?? louvainModule) as LouvainFn

/**
 * PRNG déterministe (mulberry32). Seed fixe = même partition à chaque
 * run. Évite la stochasticité de Louvain qui produit des partitions
 * différentes selon l'ordre random walk.
 */
function deterministicRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

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
type CommunityResult = { communities: ImportCommunity[]; score: ModularityScore }

/** Fresh empty (factory, pas const aliasé) — évite mutation par les callers. */
function emptyResult(): CommunityResult {
  return {
    communities: [],
    score: { globalModularityX1000: 0, communityCount: 0, misplacedCount: 0 },
  }
}

export function computeCommunityDetection(
  nodes: GraphNode[],
  edges: GraphEdge[],
): CommunityResult {
  if (nodes.length < 4 || edges.length < 3) return emptyResult()

  const filteredNodes = nodes.filter((n) => isSourceFile(n.id))
  const filteredEdges = edges.filter((e) => isSourceFile(e.from) && isSourceFile(e.to))
  if (filteredNodes.length < 4 || filteredEdges.length < 3) return emptyResult()

  const g = buildLouvainGraph(filteredNodes, filteredEdges)
  if (g.size === 0) return emptyResult()

  // Seed fixe (42) pour déterminisme — évite les partitions volatiles.
  const rngOpts = { rng: deterministicRng(42), randomWalk: false }
  const partition = louvain(g, rngOpts)
  const modularity = louvain.detailed(g, rngOpts).modularity

  const dominantPackageOf = findDominantPackages(partition)
  const { communities, misplacedCount } = emitCommunities(partition, dominantPackageOf)

  return {
    communities,
    score: {
      globalModularityX1000: Math.round(modularity * 1000),
      communityCount: new Set(Object.values(partition)).size,
      misplacedCount,
    },
  }
}

/**
 * Filtre les fichiers de build (dist/*.d.ts, *.js.map, etc.) qui
 * peuvent traîner dans le snapshot mais ne sont pas du code source
 * actionnable. Sinon ils polluent les misplaced detections.
 */
function isSourceFile(file: string): boolean {
  if (file.includes('/dist/')) return false
  if (file.includes('/build/')) return false
  if (file.endsWith('.d.ts')) return false
  if (file.endsWith('.js.map') || file.endsWith('.d.ts.map')) return false
  return true
}

interface UndirectedGraph {
  hasNode: (id: string) => boolean
  addNode: (id: string) => void
  hasEdge: (a: string, b: string) => boolean
  addEdge: (a: string, b: string) => void
  size: number
}

type GraphCtor = new (opts: { type: string; allowSelfLoops: boolean }) => UndirectedGraph

function buildLouvainGraph(
  filteredNodes: GraphNode[],
  filteredEdges: GraphEdge[],
): UndirectedGraph {
  const g = new (Graph as unknown as GraphCtor)({ type: 'undirected', allowSelfLoops: false })
  for (const n of filteredNodes) {
    if (!g.hasNode(n.id)) g.addNode(n.id)
  }
  for (const e of filteredEdges) {
    if (e.from === e.to) continue
    if (!g.hasNode(e.from) || !g.hasNode(e.to)) continue
    if (g.hasEdge(e.from, e.to) || g.hasEdge(e.to, e.from)) continue
    g.addEdge(e.from, e.to)
  }
  return g
}

/**
 * Heuristique : packages/<X>/src/... → "packages/<X>" ; apps/<X>/... → "apps/<X>" ;
 * sentinel-core | sentinel-web → top-level direct ; sinon 2 premiers segments.
 */
function physicalPackageOf(file: string): string {
  const parts = file.split(path.sep).filter(Boolean)
  if (parts[0] === 'packages' && parts.length > 1) return `packages/${parts[1]}`
  if (parts[0] === 'apps' && parts.length > 1) return `apps/${parts[1]}`
  if (parts[0] === 'sentinel-core' || parts[0] === 'sentinel-web') return parts[0]
  return parts.slice(0, 2).join('/')
}

/** Pour chaque community, retourne le package physique majoritaire. */
function findDominantPackages(partition: Record<string, number>): Map<number, string> {
  const communityToPackage = new Map<number, Map<string, number>>()
  for (const file of Object.keys(partition)) {
    const cid = partition[file]
    const pkg = physicalPackageOf(file)
    if (!communityToPackage.has(cid)) communityToPackage.set(cid, new Map())
    const pkgCount = communityToPackage.get(cid)!
    pkgCount.set(pkg, (pkgCount.get(pkg) ?? 0) + 1)
  }

  const dominantPackageOf = new Map<number, string>()
  for (const [cid, pkgCount] of communityToPackage) {
    dominantPackageOf.set(cid, argmaxKey(pkgCount))
  }
  return dominantPackageOf
}

/** Retourne la clé associée à la valeur max du Map. Empty Map → ''. */
function argmaxKey(map: Map<string, number>): string {
  let maxKey = ''
  let maxN = 0
  for (const [k, n] of map) {
    if (n > maxN) {
      maxN = n
      maxKey = k
    }
  }
  return maxKey
}

function emitCommunities(
  partition: Record<string, number>,
  dominantPackageOf: Map<number, string>,
): { communities: ImportCommunity[]; misplacedCount: number } {
  const communities: ImportCommunity[] = []
  let misplacedCount = 0
  for (const file of Object.keys(partition).sort()) {
    const cid = partition[file]
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
  return { communities, misplacedCount }
}
