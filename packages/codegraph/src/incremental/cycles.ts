/**
 * Incremental cycles — Tarjan SCC global + détection de gates per-fichier.
 *
 * Architecture :
 *   - `gateCallsOfFile(path)` : derived → CycleGate[] (call sites
 *     matching gate patterns dans CE fichier). Cache via fileContent.
 *   - `allCycles(label)` : derived global qui prend graphEdgesInput +
 *     projectFiles, run Tarjan SCC, et pour chaque cycle assemble les
 *     gates depuis les bundles per-file.
 *
 * Note : la SCC globale recompute à chaque changement d'edges (input
 * change = invalide). C'est attendu — la structure du graph dicte les
 * cycles. Le bénéfice incremental est sur les `gateCallsOfFile` (AST
 * scan) qui restent cached si fileContent ne change pas.
 */

import { derived, input } from '@liby/salsa'
import {
  scanGateCallsInSourceFile,
  compileGatePatterns,
  DEFAULT_GATE_NAMES,
  DEFAULT_EDGE_TYPES,
  type GatePattern,
} from '../extractors/cycles.js'
import type { Cycle, CycleGate, GraphEdge, EdgeType } from '../core/types.js'
import { sharedDb as db } from './database.js'
import {
  fileContent,
  projectFiles,
  getIncrementalProject,
  getIncrementalRootDir,
} from './queries.js'
import { graphEdgesInput } from './truth-points.js'
import * as path from 'node:path'
import { createHash } from 'node:crypto'

const GATE_PATTERNS: GatePattern[] = compileGatePatterns(DEFAULT_GATE_NAMES)

export const gateCallsOfFile = derived<string, CycleGate[]>(
  db, 'gateCallsOfFile',
  (filePath) => {
    fileContent.get(filePath)
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) return []
    return scanGateCallsInSourceFile(sf, filePath, GATE_PATTERNS)
  },
)

export const allCycles = derived<string, Cycle[]>(
  db, 'allCycles',
  (label) => {
    const files = projectFiles.get(label)
    const fileSet = new Set(files)
    const allEdges = graphEdgesInput.has(label)
      ? graphEdgesInput.get(label) as GraphEdge[]
      : []

    const edgeTypes = new Set<EdgeType>(DEFAULT_EDGE_TYPES)

    const adj = new Map<string, Set<string>>()
    const edgeIndex = new Map<string, GraphEdge[]>()

    for (const e of allEdges) {
      if (!edgeTypes.has(e.type)) continue
      if (!fileSet.has(e.from) || !fileSet.has(e.to)) continue
      if (e.from === e.to) continue

      if (!adj.has(e.from)) adj.set(e.from, new Set())
      adj.get(e.from)!.add(e.to)

      const key = `${e.from}→${e.to}`
      if (!edgeIndex.has(key)) edgeIndex.set(key, [])
      edgeIndex.get(key)!.push(e)
    }

    const sccs = tarjanScc(adj)
    const cycles: Cycle[] = []

    for (const scc of sccs) {
      if (scc.length < 2) continue
      const sccSet = new Set(scc)
      const start = [...scc].sort()[0]
      const cyclePath = findCycleInScc(start, adj, sccSet)
      if (!cyclePath) continue

      const cycleEdges: { from: string; to: string; type: EdgeType; label?: string }[] = []
      for (let i = 0; i < cyclePath.length - 1; i++) {
        const from = cyclePath[i]
        const to = cyclePath[i + 1]
        const candidates = edgeIndex.get(`${from}→${to}`) ?? []
        const chosen = pickRepresentativeEdge(candidates)
        if (chosen) {
          cycleEdges.push({
            from: chosen.from,
            to: chosen.to,
            type: chosen.type,
            ...(chosen.label ? { label: chosen.label } : {}),
          })
        }
      }

      // Gates : assemble via cache per-file
      const cycleFiles = [...new Set(cyclePath)]
      const gates: CycleGate[] = []
      for (const f of cycleFiles) {
        gates.push(...gateCallsOfFile.get(f))
      }
      gates.sort((a, b) => {
        if (a.file !== b.file) return a.file < b.file ? -1 : 1
        if (a.line !== b.line) return a.line - b.line
        return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0
      })

      const id = createHash('sha1').update([...scc].sort().join('|')).digest('hex').slice(0, 12)
      cycles.push({
        id,
        nodes: cyclePath,
        edges: cycleEdges,
        gated: gates.length > 0,
        gates,
        size: cyclePath.length - 1,
        sccSize: scc.length,
      })
    }

    cycles.sort((a, b) => {
      if (a.gated !== b.gated) return a.gated ? 1 : -1
      if (a.sccSize !== b.sccSize) return a.sccSize - b.sccSize
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })

    return cycles
  },
)

// ─── Tarjan SCC + cycle path (copies du legacy, sync seulement) ──────────────

function tarjanScc(adj: Map<string, Set<string>>): string[][] {
  const nodes: string[] = []
  for (const k of adj.keys()) nodes.push(k)
  for (const targets of adj.values()) for (const t of targets) if (!nodes.includes(t)) nodes.push(t)

  let index = 0
  const indices = new Map<string, number>()
  const lowlinks = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const result: string[][] = []

  function strongconnect(v: string): void {
    indices.set(v, index)
    lowlinks.set(v, index)
    index++
    stack.push(v)
    onStack.add(v)

    const out = adj.get(v) ?? new Set()
    for (const w of out) {
      if (!indices.has(w)) {
        strongconnect(w)
        lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!))
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!))
      }
    }

    if (lowlinks.get(v) === indices.get(v)) {
      const scc: string[] = []
      while (true) {
        const w = stack.pop()!
        onStack.delete(w)
        scc.push(w)
        if (w === v) break
      }
      result.push(scc)
    }
  }

  for (const v of nodes) {
    if (!indices.has(v)) strongconnect(v)
  }
  return result
}

function findCycleInScc(
  start: string,
  adj: Map<string, Set<string>>,
  sccSet: Set<string>,
): string[] | null {
  const visited = new Set<string>()
  const stack: string[] = [start]
  visited.add(start)

  function dfs(node: string): string[] | null {
    const neighbors = [...(adj.get(node) ?? [])].filter((n) => sccSet.has(n)).sort()
    for (const n of neighbors) {
      if (n === start && stack.length >= 2) {
        return [...stack, start]
      }
      if (visited.has(n)) continue
      visited.add(n)
      stack.push(n)
      const found = dfs(n)
      if (found) return found
      stack.pop()
      visited.delete(n)
    }
    return null
  }

  return dfs(start)
}

function pickRepresentativeEdge(edges: GraphEdge[]): GraphEdge | null {
  if (edges.length === 0) return null
  const priority: Record<string, number> = {
    'event': 0,
    'queue': 1,
    'dynamic-load': 2,
    'import': 3,
  }
  return [...edges].sort((a, b) => {
    const pa = priority[a.type] ?? 99
    const pb = priority[b.type] ?? 99
    return pa - pb
  })[0]
}
