/**
 * DSM — Dependency Structure Matrix — phase 3.8 #4.
 *
 * Partitionne les nodes via Tarjan SCC, ordonne le DAG condensé topologiquement
 * (Kahn, tie-break lex), puis émet chaque SCC dans cet ordre (tri alpha intra-
 * SCC). Construit la matrice : `matrix[i][j] = 1` ssi `order[i]` importe
 * `order[j]`. Les back-edges (fromIdx > toIdx, sous-diagonale) signalent les
 * boucles.
 *
 * Pure arithmétique sur la liste de nodes et d'edges — aucune dépendance à
 * ts-morph ni aux autres extracteurs. Réutilisable avec n'importe quelle
 * granularité : file-level, container-level, etc.
 */

import type { DsmResult } from '../core/types.js'

export interface DsmOptions {
  /**
   * Filtre les edges par type si caller passe un snapshot edge brut. Par
   * défaut, tout edge fourni est pris. Le caller est responsable du filtrage
   * en amont pour simplicité.
   */
}

export function computeDsm(
  nodes: string[],
  edges: Array<{ from: string; to: string }>,
  _options: DsmOptions = {},
): DsmResult {
  const adj = buildAdjacency(nodes, edges)
  const sccs = tarjanScc(nodes, adj)
  const sccIdOf = invertSccs(sccs)
  const condAdj = buildCondensedDag(adj, sccIdOf, sccs.length)
  const minIdOf = computeMinIdOfScc(sccs)
  const topoOrder = topoSortCondensed(condAdj, sccs.length, minIdOf)
  const { order, levels } = emitOrderFromSccs(topoOrder, sccs)
  const { matrix, backEdges } = buildMatrixAndBackEdges(order, adj)
  return { order, levels, matrix, backEdges }
}

// ─── Phase 0: adjacency (dédup, no self-loops) ─────────────────────────────

function buildAdjacency(
  nodes: string[],
  edges: Array<{ from: string; to: string }>,
): Map<string, Set<string>> {
  const nodeSet = new Set(nodes)
  const adj = new Map<string, Set<string>>()
  for (const n of nodes) adj.set(n, new Set())
  for (const e of edges) {
    if (!nodeSet.has(e.from) || !nodeSet.has(e.to)) continue
    if (e.from === e.to) continue
    adj.get(e.from)!.add(e.to)
  }
  return adj
}

// ─── Phase 2: invert SCCs into nodeId → sccId map ───────────────────────────

function invertSccs(sccs: string[][]): Map<string, number> {
  const sccIdOf = new Map<string, number>()
  sccs.forEach((scc, i) => { for (const n of scc) sccIdOf.set(n, i) })
  return sccIdOf
}

// ─── Phase 2b: condensation DAG (sccId → sccId edges) ───────────────────────

function buildCondensedDag(
  adj: Map<string, Set<string>>,
  sccIdOf: Map<string, number>,
  sccCount: number,
): Map<number, Set<number>> {
  const condAdj = new Map<number, Set<number>>()
  for (let i = 0; i < sccCount; i++) condAdj.set(i, new Set())
  for (const [from, targets] of adj) {
    const a = sccIdOf.get(from)!
    for (const to of targets) {
      const b = sccIdOf.get(to)!
      if (a !== b) condAdj.get(a)!.add(b)
    }
  }
  return condAdj
}

/** Pour tie-break stable du topo sort : min-id (alpha) de chaque SCC. */
function computeMinIdOfScc(sccs: string[][]): Map<number, string> {
  const minIdOf = new Map<number, string>()
  sccs.forEach((scc, i) => { minIdOf.set(i, [...scc].sort()[0]!) })
  return minIdOf
}

// ─── Phase 3: topo sort (Kahn, lex tie-break) ───────────────────────────────

function topoSortCondensed(
  condAdj: Map<number, Set<number>>,
  sccCount: number,
  minIdOf: Map<number, string>,
): number[] {
  const indeg = new Map<number, number>()
  for (let i = 0; i < sccCount; i++) indeg.set(i, 0)
  for (const targets of condAdj.values()) {
    for (const t of targets) indeg.set(t, (indeg.get(t) ?? 0) + 1)
  }

  const ready: number[] = []
  for (let i = 0; i < sccCount; i++) {
    if ((indeg.get(i) ?? 0) === 0) ready.push(i)
  }
  ready.sort((a, b) => minIdOf.get(a)!.localeCompare(minIdOf.get(b)!))

  const topoOrder: number[] = []
  while (ready.length > 0) {
    const cur = ready.shift()!
    topoOrder.push(cur)
    for (const nxt of condAdj.get(cur)!) {
      const d = (indeg.get(nxt) ?? 0) - 1
      indeg.set(nxt, d)
      if (d === 0) insertSortedByMinId(ready, nxt, minIdOf)
    }
  }
  return topoOrder
}

/** Insertion triée par minIdOf, binary scan. O(log N) lookup, O(N) splice. */
function insertSortedByMinId(
  ready: number[],
  val: number,
  minIdOf: Map<number, string>,
): void {
  const key = minIdOf.get(val)!
  let lo = 0, hi = ready.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (minIdOf.get(ready[mid]!)!.localeCompare(key) < 0) lo = mid + 1
    else hi = mid
  }
  ready.splice(lo, 0, val)
}

// ─── Phase 4: emit order : SCC par SCC, membres tri alpha ──────────────────

function emitOrderFromSccs(
  topoOrder: number[],
  sccs: string[][],
): { order: string[]; levels: string[][] } {
  const order: string[] = []
  const levels: string[][] = []
  for (const sccId of topoOrder) {
    const members = [...sccs[sccId]!].sort()
    levels.push(members)
    order.push(...members)
  }
  return { order, levels }
}

// ─── Phase 5: matrix + back-edges ───────────────────────────────────────────

function buildMatrixAndBackEdges(
  order: string[],
  adj: Map<string, Set<string>>,
): { matrix: number[][]; backEdges: DsmResult['backEdges'] } {
  const idxOf = new Map<string, number>()
  order.forEach((n, i) => idxOf.set(n, i))

  const N = order.length
  const matrix: number[][] = Array.from({ length: N }, () => new Array<number>(N).fill(0))
  const backEdges: DsmResult['backEdges'] = []

  for (const [from, targets] of adj) {
    const i = idxOf.get(from)!
    for (const to of targets) {
      const j = idxOf.get(to)!
      matrix[i]![j] = 1
      if (i > j) backEdges.push({ from, to, fromIdx: i, toIdx: j })
    }
  }

  backEdges.sort((a, b) => {
    if (a.fromIdx !== b.fromIdx) return a.fromIdx - b.fromIdx
    return a.toIdx - b.toIdx
  })
  return { matrix, backEdges }
}

// ─── Tarjan SCC (itératif) ────────────────────────────────────────────

function tarjanScc(
  nodes: string[],
  adj: Map<string, Set<string>>,
): string[][] {
  const index = new Map<string, number>()
  const lowlink = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const sccs: string[][] = []
  let nextIndex = 0

  // Tri alpha des nodes → déterminisme total des SCC indices.
  const sortedNodes = [...nodes].sort()

  // Frame machine pour éviter la récursion profonde.
  interface Frame {
    node: string
    iter: Iterator<string>
    pendingChild?: string
  }

  for (const startNode of sortedNodes) {
    if (index.has(startNode)) continue

    const callStack: Frame[] = []
    const pushNode = (node: string): void => {
      index.set(node, nextIndex)
      lowlink.set(node, nextIndex)
      nextIndex++
      stack.push(node)
      onStack.add(node)
      const neighbors = [...(adj.get(node) ?? [])].sort()
      callStack.push({ node, iter: neighbors[Symbol.iterator]() })
    }

    pushNode(startNode)

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1]!

      if (frame.pendingChild !== undefined) {
        const child = frame.pendingChild
        frame.pendingChild = undefined
        lowlink.set(frame.node, Math.min(lowlink.get(frame.node)!, lowlink.get(child)!))
      }

      const next = frame.iter.next()
      if (next.done) {
        // Fin des voisins : SCC root check.
        if (lowlink.get(frame.node) === index.get(frame.node)) {
          const scc: string[] = []
          while (true) {
            const w = stack.pop()!
            onStack.delete(w)
            scc.push(w)
            if (w === frame.node) break
          }
          sccs.push(scc)
        }
        callStack.pop()
        if (callStack.length > 0) {
          callStack[callStack.length - 1]!.pendingChild = frame.node
        }
        continue
      }

      const child = next.value
      if (!index.has(child)) {
        frame.pendingChild = child
        pushNode(child)
      } else if (onStack.has(child)) {
        lowlink.set(frame.node, Math.min(lowlink.get(frame.node)!, index.get(child)!))
      }
    }
  }

  return sccs
}
