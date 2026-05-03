/**
 * Articulation Points — détecteur déterministe (Phase 4 Tier 5).
 *
 * Algo Tarjan O(V+E) sur le graphe d'imports rendu NON-DIRIGÉ.
 *
 * Un articulation point (cut vertex) est un nœud dont la suppression
 * DÉCONNECTE le graphe en plusieurs composantes connexes. Pour notre
 * cas : un fichier dont la suppression isolerait des packs entiers
 * du reste du codebase.
 *
 * Pourquoi : ces hubs cachés ne sont pas forcément top-importés (donc
 * absents du HIGH-RISK header existant), mais leur suppression casse
 * l'architecture. Un agent sans mémoire risque de les toucher sans
 * réaliser le blast radius — articulation point = "ce fichier est le
 * seul lien entre A et B".
 *
 * Algorithme Tarjan :
 *   - DFS depuis chaque nœud non visité.
 *   - Pour chaque nœud u, calcule disc[u] (discovery time) et low[u]
 *     (lowest disc atteignable depuis le subtree de u via une arête
 *     back).
 *   - u est articulation si :
 *     - u est racine du DFS et a >= 2 enfants DFS, OU
 *     - u n'est pas racine et a un enfant v tel que low[v] >= disc[u].
 *
 * Le graphe d'imports est transformé en non-dirigé : pour chaque
 * import edge A → B, on ajoute (A,B) ET (B,A) à l'adjacence.
 *
 * Bonus : on calcule aussi le NOMBRE de composantes désconnectées
 * obtenu en retirant le nœud — donne un score de criticité (`severity`).
 */

export interface ArticulationPoint {
  file: string
  /** Nombre de composantes connexes obtenues en retirant ce fichier. */
  severity: number
}

interface Edge {
  from: string
  to: string
  type: string
}

interface Node {
  id: string
}

export function findArticulationPoints(
  nodes: Node[],
  edges: Edge[],
  options: { includeIndirect?: boolean } = {},
): ArticulationPoint[] {
  const includeIndirect = options.includeIndirect ?? false
  const nodeIds = new Set<string>(nodes.map((n) => n.id))
  const adj = buildUndirectedAdjacency(nodeIds, edges, includeIndirect)
  const isAP = findApsViaDfs(nodeIds, adj)
  return rankArticulationPoints(isAP, nodeIds, adj)
}

/** Build adjacency non-dirigée depuis edges import (+ event/queue si indirect). */
function buildUndirectedAdjacency(
  nodeIds: Set<string>,
  edges: Edge[],
  includeIndirect: boolean,
): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>()
  for (const id of nodeIds) adj.set(id, new Set())
  for (const e of edges) {
    if (e.type !== 'import' && !(includeIndirect && (e.type === 'event' || e.type === 'queue'))) continue
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) continue
    adj.get(e.from)!.add(e.to)
    adj.get(e.to)!.add(e.from)
  }
  return adj
}

interface DfsState {
  disc: Map<string, number>
  low: Map<string, number>
  parent: Map<string, string | null>
  isAP: Set<string>
  time: number
}

/** Tarjan iterative DFS pour articulation points. Évite stack overflow. */
function findApsViaDfs(
  nodeIds: Set<string>,
  adj: Map<string, Set<string>>,
): Set<string> {
  const state: DfsState = {
    disc: new Map(),
    low: new Map(),
    parent: new Map(),
    isAP: new Set(),
    time: 0,
  }
  for (const root of [...nodeIds].sort()) {
    if (state.disc.has(root)) continue
    runApDfsFrom(root, adj, state)
  }
  return state.isAP
}

interface ApFrame { node: string; neighbors: string[]; idx: number }

function runApDfsFrom(
  root: string,
  adj: Map<string, Set<string>>,
  state: DfsState,
): void {
  state.parent.set(root, null)
  let rootChildren = 0
  const stack: ApFrame[] = [{
    node: root,
    neighbors: [...adj.get(root)!].sort(),
    idx: 0,
  }]
  state.disc.set(root, state.time)
  state.low.set(root, state.time)
  state.time++

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]
    if (frame.idx < frame.neighbors.length) {
      const v = frame.neighbors[frame.idx++]
      rootChildren += processApNeighbor(frame, v, root, adj, state, stack)
    } else {
      stack.pop()
      finalizeApFrame(frame.node, root, state)
    }
  }
  if (rootChildren >= 2) state.isAP.add(root)
}

/**
 * Process un voisin durant DFS : si non visité, push frame et retourne 1 si
 * on est à la racine (compte comme child du root). Sinon update low[u] si
 * back edge (et pas l'arc parent).
 */
function processApNeighbor(
  frame: ApFrame,
  v: string,
  root: string,
  adj: Map<string, Set<string>>,
  state: DfsState,
  stack: ApFrame[],
): number {
  if (!state.disc.has(v)) {
    state.parent.set(v, frame.node)
    state.disc.set(v, state.time)
    state.low.set(v, state.time)
    state.time++
    stack.push({ node: v, neighbors: [...adj.get(v)!].sort(), idx: 0 })
    return frame.node === root ? 1 : 0
  }
  if (v !== state.parent.get(frame.node)) {
    // Back edge : update low[u]
    state.low.set(frame.node, Math.min(state.low.get(frame.node)!, state.disc.get(v)!))
  }
  return 0
}

/**
 * Pop : on a fini ce nœud. Update parent.low ; si low[u] >= disc[parent] et
 * parent != root, alors parent est articulation point.
 */
function finalizeApFrame(u: string, root: string, state: DfsState): void {
  const parentU = state.parent.get(u)
  if (parentU === null || parentU === undefined) return
  state.low.set(parentU, Math.min(state.low.get(parentU)!, state.low.get(u)!))
  if (parentU !== root && state.low.get(u)! >= state.disc.get(parentU)!) {
    state.isAP.add(parentU)
  }
}

function rankArticulationPoints(
  isAP: Set<string>,
  nodeIds: Set<string>,
  adj: Map<string, Set<string>>,
): ArticulationPoint[] {
  const result: ArticulationPoint[] = []
  for (const ap of [...isAP].sort()) {
    result.push({ file: ap, severity: countComponentsWithout(nodeIds, adj, ap) })
  }
  return result
}

/**
 * Compte les composantes connexes du graphe après avoir retiré `excluded`.
 * BFS basique. Pour un articulation point, le résultat est >= 2.
 */
function countComponentsWithout(
  nodeIds: Set<string>,
  adj: Map<string, Set<string>>,
  excluded: string,
): number {
  const visited = new Set<string>([excluded])
  let components = 0
  for (const start of nodeIds) {
    if (visited.has(start)) continue
    components++
    const queue: string[] = [start]
    visited.add(start)
    while (queue.length > 0) {
      const n = queue.shift()!
      for (const neighbor of adj.get(n) ?? []) {
        if (visited.has(neighbor)) continue
        visited.add(neighbor)
        queue.push(neighbor)
      }
    }
  }
  return components
}

/**
 * Aggregator du codegraph snapshot.
 */
export async function analyzeArticulationPoints(
  snapshot: { nodes?: Array<{ id: string; type?: string }>; edges?: Edge[] },
  options: { includeIndirect?: boolean } = {},
): Promise<ArticulationPoint[]> {
  const fileNodes = (snapshot.nodes ?? []).filter((n) => n.type === 'file' || n.type === undefined)
  const aps = findArticulationPoints(
    fileNodes.map((n) => ({ id: n.id })),
    snapshot.edges ?? [],
    options,
  )
  // Tri par severity descendant puis file ascendant.
  aps.sort((a, b) => {
    if (a.severity !== b.severity) return b.severity - a.severity
    return a.file < b.file ? -1 : 1
  })
  return aps
}
