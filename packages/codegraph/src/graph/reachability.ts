/**
 * Reachability helpers — phase 3.7 #1.
 *
 * Calcul BFS de l'accessibilité transitive sur un subgraph d'edges. Utilisé
 * par la règle `arch-rules-reachable` (disallow multi-hop) et par le CLI
 * `codegraph reach`.
 *
 * Déterministe : traversée BFS depuis des sources triées, pas d'aléatoire.
 *
 * Coût : O(N × E) au pire (BFS par source). Pour 182 fichiers × 628 import
 * edges, quelques dizaines de ms. Si un projet plus gros demande du cache,
 * on pourra précompiler une matrice (O(N²) mémoire) — pas nécessaire v1.
 */

import type { GraphEdge } from '../core/types.js'

export interface ReachabilityOptions {
  /** Types d'edges inclus dans la traversée. Default : `import`. */
  edgeTypes?: Array<GraphEdge['type']>
}

/**
 * Calcule, pour chaque source, la liste des paths transitifs vers chaque
 * cible. Retourne un path minimal (BFS trouve le plus court en nombre de
 * hops). Optimisé : on ne calcule pas tous les paths vers tous les nœuds
 * — seulement ceux qui matchent un prédicat.
 */
interface ReachablePath { from: string; to: string; path: string[] }

export function findReachablePaths(
  sources: Set<string>,
  targets: Set<string>,
  edges: GraphEdge[],
  options: ReachabilityOptions = {},
): ReachablePath[] {
  const edgeTypes = new Set(options.edgeTypes ?? (['import'] as Array<GraphEdge['type']>))
  const adj = buildSortedAdjacency(edges, edgeTypes)

  const out: ReachablePath[] = []
  for (const src of [...sources].sort()) {
    const parent = bfsFromSource(src, adj)
    collectPathsToTargets(src, targets, parent, out)
  }
  out.sort(compareReachablePath)
  return out
}

/** Adjacency list filtrée + sortée (déterminisme de la BFS). */
function buildSortedAdjacency(
  edges: GraphEdge[],
  edgeTypes: Set<GraphEdge['type']>,
): Map<string, string[]> {
  const adj = new Map<string, string[]>()
  for (const e of edges) {
    if (!edgeTypes.has(e.type)) continue
    const list = adj.get(e.from) ?? []
    list.push(e.to)
    adj.set(e.from, list)
  }
  for (const list of adj.values()) list.sort()
  return adj
}

/**
 * BFS depuis src. `parent` garde le prédécesseur pour reconstruire le path.
 * parent.get(src) === null = source (pas de prédécesseur).
 */
function bfsFromSource(
  src: string,
  adj: Map<string, string[]>,
): Map<string, string | null> {
  const parent = new Map<string, string | null>()
  parent.set(src, null)
  const queue: string[] = [src]
  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const nxt of adj.get(cur) ?? []) {
      if (parent.has(nxt)) continue
      parent.set(nxt, cur)
      queue.push(nxt)
    }
  }
  return parent
}

/**
 * Reconstruct paths from src to chaque target accessible.
 * Skip trivial 1-hop (couvert par direct `disallow`, pas `disallowReachable`).
 */
function collectPathsToTargets(
  src: string,
  targets: Set<string>,
  parent: Map<string, string | null>,
  out: ReachablePath[],
): void {
  for (const tgt of targets) {
    if (tgt === src) continue
    if (!parent.has(tgt)) continue
    const path = reconstructPath(tgt, parent)
    if (path.length < 3) continue
    out.push({ from: src, to: tgt, path })
  }
}

/** Walk parent chain from tgt back to source — return path src → tgt. */
function reconstructPath(tgt: string, parent: Map<string, string | null>): string[] {
  const path: string[] = []
  let cur: string | null = tgt
  while (cur !== null) {
    path.unshift(cur)
    cur = parent.get(cur) ?? null
  }
  return path
}

function compareReachablePath(a: ReachablePath, b: ReachablePath): number {
  if (a.from !== b.from) return a.from < b.from ? -1 : 1
  if (a.to !== b.to) return a.to < b.to ? -1 : 1
  return 0
}

/**
 * Glob-to-regex minimaliste — cohérent avec le matcher côté sentinel-core
 * pour que les patterns `arch-rules.json` aient la même sémantique partout.
 */
export function globToRegex(glob: string): RegExp {
  let re = ''
  let i = 0
  while (i < glob.length) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*'
      i += 2
      if (glob[i] === '/') i++
    } else if (c === '*') {
      re += '[^/]*'
      i++
    } else if ('.+?^$()[]{}|\\'.includes(c)) {
      re += '\\' + c
      i++
    } else {
      re += c
      i++
    }
  }
  return new RegExp('^' + re + '$')
}
