/**
 * Min-cut / max-flow entre packages — théorie des flots (Ford-Fulkerson 1956).
 *
 * Origine : pour 2 ensembles de noeuds source S et target T, le min-cut
 * est le nombre minimum d'arêtes à supprimer pour déconnecter S de T.
 * Théorème max-flow min-cut : ce nombre = flux max possible de S vers T.
 *
 * Application au code : pour 2 packages distincts (P1, P2), le min-cut
 * sur le graphe d'imports = nombre d'imports cross-package qu'il faudrait
 * supprimer pour les rendre indépendants. Mesure objective du COÛT DE
 * SÉPARATION.
 *
 * - min-cut faible (1-3) : packages quasi-decouple, split possible
 *   moyennant peu d'effort. Candidat extraction monorepo → multi-repo.
 * - min-cut moyen (4-10) : couplage modeste, refactor non-trivial.
 * - min-cut élevé (>10) : packages intriqués, frontière artificielle.
 *
 * Distinction avec PageRank ou Fiedler : ces deux mesurent la centralite
 * GLOBALE. Min-cut mesure la SEPARABILITE LOCALE entre 2 ensembles
 * specifiques. Orthogonal.
 *
 * Algorithm : Edmonds-Karp BFS sur le graphe résiduel (variant simple
 * de Ford-Fulkerson, O(V × E²) pire cas, suffisant pour nos N < 300
 * fichiers). Pour traiter le graphe d'imports comme un flow network,
 * on assigne capacité 1 à chaque edge.
 */

import type { GraphNode, GraphEdge } from '../core/types.js'

export interface PackageMinCut {
  /** Source package (premier 2 segments du path, e.g. "packages/codegraph"). */
  fromPackage: string
  /** Target package. */
  toPackage: string
  /** Nb d'edges import cross-package. */
  edgeCount: number
  /** Min cut entre les 2 packages = max-flow. */
  minCut: number
  /** Sample (jusqu'à 5) des edges traversant la frontière. */
  sampleEdges: string[]
}

function packageOf(filePath: string): string {
  const parts = filePath.split('/')
  if (parts[0] === 'packages' && parts.length >= 2) {
    return parts.slice(0, 2).join('/')
  }
  return parts[0] ?? ''
}

/**
 * BFS sur graphe résiduel pour trouver augmenting path.
 * Retourne le path (list de nodes) ou null si pas de path possible.
 */
function bfsAugmentingPath(
  capacity: Map<string, Map<string, number>>,
  source: Set<string>,
  target: Set<string>,
): string[] | null {
  const visited = new Set<string>(source)
  const queue: Array<{ node: string; path: string[] }> = []
  for (const s of source) queue.push({ node: s, path: [s] })

  while (queue.length > 0) {
    const { node, path } = queue.shift()!
    const neighbors = capacity.get(node)
    if (!neighbors) continue
    for (const [next, cap] of neighbors) {
      if (cap <= 0 || visited.has(next)) continue
      const newPath = [...path, next]
      if (target.has(next)) return newPath
      visited.add(next)
      queue.push({ node: next, path: newPath })
    }
  }
  return null
}

function maxFlow(
  edges: Array<{ from: string; to: string }>,
  source: Set<string>,
  target: Set<string>,
): number {
  // Capacity map : node → Map<neighbor, capacity>
  const cap = new Map<string, Map<string, number>>()
  const ensureNode = (n: string): void => {
    if (!cap.has(n)) cap.set(n, new Map())
  }
  for (const e of edges) {
    ensureNode(e.from); ensureNode(e.to)
    // Edge undirected pour min-cut (capacity 1 each direction).
    const fwd = cap.get(e.from)!
    const bwd = cap.get(e.to)!
    fwd.set(e.to, (fwd.get(e.to) ?? 0) + 1)
    bwd.set(e.from, (bwd.get(e.from) ?? 0) + 1)
  }

  let flow = 0
  while (true) {
    const path = bfsAugmentingPath(cap, source, target)
    if (!path) break
    // Bottleneck = min capacity along path. Avec capacity 1 partout, c'est 1.
    flow += 1
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i], b = path[i + 1]
      cap.get(a)!.set(b, (cap.get(a)!.get(b) ?? 0) - 1)
      cap.get(b)!.set(a, (cap.get(b)!.get(a) ?? 0) + 1)
    }
  }
  return flow
}

export function computePackageMinCuts(
  nodes: GraphNode[],
  edges: GraphEdge[],
): PackageMinCut[] {
  const fileNodes = nodes.filter((n) => n.type === 'file')
  if (fileNodes.length < 4) return []

  const pkgFiles = groupFilesByPackage(fileNodes)
  if (pkgFiles.size < 2) return []

  const importEdges = edges.filter((e) => e.type === 'import')
    .map((e) => ({ from: e.from, to: e.to }))

  const pkgs = [...pkgFiles.keys()].sort()
  const out: PackageMinCut[] = []
  for (let i = 0; i < pkgs.length; i++) {
    for (let j = i + 1; j < pkgs.length; j++) {
      const cut = computeOnePairCut(pkgs[i], pkgs[j], pkgFiles, importEdges)
      if (cut) out.push(cut)
    }
  }
  out.sort((a, b) => a.minCut - b.minCut)
  return out
}

function groupFilesByPackage(fileNodes: GraphNode[]): Map<string, string[]> {
  const pkgFiles = new Map<string, string[]>()
  for (const n of fileNodes) {
    const p = packageOf(n.id)
    if (!p) continue
    if (!pkgFiles.has(p)) pkgFiles.set(p, [])
    pkgFiles.get(p)!.push(n.id)
  }
  return pkgFiles
}

/** Compute min-cut + sample edges pour une paire (p1, p2). null si pas de crossing edges. */
function computeOnePairCut(
  p1: string,
  p2: string,
  pkgFiles: Map<string, string[]>,
  importEdges: Array<{ from: string; to: string }>,
): PackageMinCut | null {
  const { edgeCount, crossing } = countCrossingEdges(p1, p2, importEdges)
  if (edgeCount === 0) return null  // Packages indépendants — pas de min-cut à calculer
  const source = new Set(pkgFiles.get(p1)!)
  const target = new Set(pkgFiles.get(p2)!)
  return {
    fromPackage: p1,
    toPackage: p2,
    edgeCount,
    minCut: maxFlow(importEdges, source, target),
    sampleEdges: crossing,
  }
}

function countCrossingEdges(
  p1: string,
  p2: string,
  importEdges: ReadonlyArray<{ from: string; to: string }>,
): { edgeCount: number; crossing: string[] } {
  const crossing: string[] = []
  let edgeCount = 0
  for (const e of importEdges) {
    const fp = packageOf(e.from)
    const tp = packageOf(e.to)
    if ((fp === p1 && tp === p2) || (fp === p2 && tp === p1)) {
      edgeCount++
      if (crossing.length < 5) crossing.push(`${e.from}→${e.to}`)
    }
  }
  return { edgeCount, crossing }
}
