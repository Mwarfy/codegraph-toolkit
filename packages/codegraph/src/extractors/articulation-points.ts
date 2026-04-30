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

  // Build adjacency non-dirigée à partir des import edges.
  const nodeIds = new Set<string>(nodes.map((n) => n.id))
  const adj = new Map<string, Set<string>>()
  for (const id of nodeIds) adj.set(id, new Set())
  for (const e of edges) {
    if (e.type !== 'import' && !(includeIndirect && (e.type === 'event' || e.type === 'queue'))) continue
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) continue
    adj.get(e.from)!.add(e.to)
    adj.get(e.to)!.add(e.from)
  }

  const disc = new Map<string, number>()
  const low = new Map<string, number>()
  const parent = new Map<string, string | null>()
  const isAP = new Set<string>()
  let time = 0

  // DFS iterative (évite stack overflow sur gros codebases).
  // Pour chaque nœud non visité, lance un DFS depuis ce nœud.
  for (const root of [...nodeIds].sort()) {
    if (disc.has(root)) continue
    parent.set(root, null)
    let rootChildren = 0

    // Stack frames : { node, neighborIter, neighborsList }
    type Frame = { node: string; neighbors: string[]; idx: number }
    const stack: Frame[] = [{
      node: root,
      neighbors: [...adj.get(root)!].sort(),
      idx: 0,
    }]
    disc.set(root, time)
    low.set(root, time)
    time++

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      if (frame.idx < frame.neighbors.length) {
        const v = frame.neighbors[frame.idx]
        frame.idx++
        if (!disc.has(v)) {
          // Nouveau child : push frame.
          parent.set(v, frame.node)
          if (frame.node === root) rootChildren++
          disc.set(v, time)
          low.set(v, time)
          time++
          stack.push({ node: v, neighbors: [...adj.get(v)!].sort(), idx: 0 })
        } else if (v !== parent.get(frame.node)) {
          // Back edge : update low[u].
          low.set(frame.node, Math.min(low.get(frame.node)!, disc.get(v)!))
        }
      } else {
        // Pop : on a fini ce nœud. Update parent's low + check AP.
        const u = frame.node
        stack.pop()
        const parentU = parent.get(u)
        if (parentU !== null && parentU !== undefined) {
          low.set(parentU, Math.min(low.get(parentU)!, low.get(u)!))
          // u-parent est articulation si low[u] >= disc[parentU] ET
          // parentU n'est pas root.
          if (parentU !== root && low.get(u)! >= disc.get(parentU)!) {
            isAP.add(parentU)
          }
        }
      }
    }
    // Root est AP si >= 2 enfants DFS.
    if (rootChildren >= 2) isAP.add(root)
  }

  // Pour chaque AP, calcule severity = nombre de composantes connexes
  // obtenues en retirant ce nœud.
  const result: ArticulationPoint[] = []
  for (const ap of [...isAP].sort()) {
    const severity = countComponentsWithout(nodeIds, adj, ap)
    result.push({ file: ap, severity })
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
