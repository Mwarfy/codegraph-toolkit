/**
 * Module-level metrics — phase 3.7 (#5 + #6).
 *
 * Pour chaque fichier :
 *   - fanIn  = edges import qui ciblent le fichier (nombre de modules qui
 *              l'importent)
 *   - fanOut = edges import qui partent du fichier (nombre de modules qu'il
 *              importe)
 *   - pageRank = PageRank sur le subgraph import. Normalisé en [0, 1] par
 *                division par le max (le plus important = 1).
 *   - henryKafura = (fanIn × fanOut)² × loc — Information-Flow Complexity
 *                   (Henry & Kafura, 1981). Détecte les god-modules.
 *
 * Zéro LLM, pure arithmétique sur le graphe déjà extrait. Déterministe :
 * même snapshot → même sortie (graphology PageRank converge à la même
 * valeur avec iterations/tolerance fixes).
 */

import Graph from 'graphology'
import pagerank from 'graphology-metrics/centrality/pagerank.js'
import type { GraphEdge, GraphNode, ModuleMetrics } from '../core/types.js'

export interface ModuleMetricsOptions {
  /**
   * Quels types d'edges entrent dans le graphe PageRank + fanIn/fanOut.
   * Default : `import` seulement. Inclure `event`/`route` fausserait le
   * signal import-layering.
   */
  edgeTypesForCentrality?: Array<GraphEdge['type']>
  /** Damping factor PageRank. Default 0.85 (standard). */
  pagerankAlpha?: number
  /** Tolerance convergence. Default 1e-6. */
  pagerankTolerance?: number
}

export function computeModuleMetrics(
  nodes: GraphNode[],
  edges: GraphEdge[],
  options: ModuleMetricsOptions = {},
): ModuleMetrics[] {
  const edgeTypes = new Set(options.edgeTypesForCentrality ?? (['import'] as Array<GraphEdge['type']>))
  const alpha = options.pagerankAlpha ?? 0.85
  const tolerance = options.pagerankTolerance ?? 1e-6

  // Garde-fou : on ne travaille que sur les nodes fichier (les directory
  // nodes servent au clustering visuel, pas à la métrique).
  const fileNodes = nodes.filter((n) => n.type === 'file')
  const fileIds = new Set(fileNodes.map((n) => n.id))

  // ─── Build graphology Graph ────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const GraphCtor = (Graph as any).default ?? Graph
  const g = new GraphCtor({ multi: false, type: 'directed', allowSelfLoops: false })

  for (const n of fileNodes) {
    g.addNode(n.id)
  }

  const fanIn = new Map<string, number>()
  const fanOut = new Map<string, number>()
  const addedEdges = new Set<string>()  // dedup pour multi-edges same pair

  for (const e of edges) {
    if (!edgeTypes.has(e.type)) continue
    if (!fileIds.has(e.from) || !fileIds.has(e.to)) continue
    if (e.from === e.to) continue  // self-loop → ignoré pour PageRank
    const key = `${e.from}→${e.to}`
    if (addedEdges.has(key)) continue
    addedEdges.add(key)
    try {
      g.addDirectedEdge(e.from, e.to)
      fanOut.set(e.from, (fanOut.get(e.from) ?? 0) + 1)
      fanIn.set(e.to, (fanIn.get(e.to) ?? 0) + 1)
    } catch {
      // Edge déjà présent (race entre multi-edges) — skip.
    }
  }

  // ─── PageRank ──────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prFn = (pagerank as any).default ?? pagerank
  // graphology-metrics v2 retourne un `Record<node, score>` via l'option
  // `getNodeCentrality` false (par défaut). On utilise la forme la plus
  // stable : appeler avec options-objet.
  let prScores: Record<string, number> = {}
  try {
    prScores = prFn(g, { alpha, tolerance, maxIterations: 500 }) as Record<string, number>
  } catch {
    // Si pagerank échoue (graphe vide, etc.) on continue avec un score nul.
  }

  let maxPr = 0
  for (const v of Object.values(prScores)) if (v > maxPr) maxPr = v
  const normalize = (v: number): number => (maxPr > 0 ? v / maxPr : 0)

  // ─── Build ModuleMetrics[] ─────────────────────────────────────────

  const result: ModuleMetrics[] = fileNodes.map((n) => {
    const fi = fanIn.get(n.id) ?? 0
    const fo = fanOut.get(n.id) ?? 0
    const loc = n.loc ?? 0
    // Henry-Kafura : `(fanIn * fanOut)²  * loc`. Quand fanIn ou fanOut = 0,
    // la complexité informationnelle est 0 (aucun flux à travers le module).
    const henryKafura = (fi * fo) * (fi * fo) * loc
    return {
      file: n.id,
      fanIn: fi,
      fanOut: fo,
      pageRank: Number(normalize(prScores[n.id] ?? 0).toFixed(6)),
      henryKafura,
      loc,
    }
  })

  // Tri : PageRank desc, puis file asc (stabilité).
  result.sort((a, b) => {
    if (a.pageRank !== b.pageRank) return b.pageRank - a.pageRank
    return a.file < b.file ? -1 : a.file > b.file ? 1 : 0
  })

  return result
}
