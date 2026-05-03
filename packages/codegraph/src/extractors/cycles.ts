/**
 * Cycles Extractor — structural map phase 1.3
 *
 * Matérialise les boucles de contrôle qui portent la dynamique du système.
 * Algorithme :
 *   1. Construit un graphe orienté depuis les edges `import + event + queue +
 *      dynamic-load` (pas `db-table` — trop bruyant, deux fichiers qui lisent
 *      la même table ne forment pas une vraie boucle).
 *   2. Tarjan SCC itératif → liste des composantes fortement connexes.
 *   3. Pour chaque SCC de taille ≥ 2 : extrait UN cycle concret via DFS
 *      depuis le plus petit-id de la SCC. Émet le path + les edges traversés.
 *   4. Pour chaque cycle, scan AST des fichiers du cycle pour détecter les
 *      "gates" — call sites vers des fonctions dont le nom matche un pattern
 *      connu (`isAllowed`, `canExecute`, `peerReview`, `checkTrust`,
 *      `guardrail*`). Un cycle avec au moins un gate est marqué `gated`.
 *
 * Les cycles non-gatés sont des zones de divergence potentielle pour un agent
 * autonome — ils remontent en premier dans le rendu MAP.md (phase 1.7).
 *
 * Trade-offs assumés :
 *   - Faux négatif > faux positif sur la détection de gate. Un cycle est
 *     considéré gated SEULEMENT si un call vers un nom connu est trouvé —
 *     les gardes inline (`if (trust.score > x)`) restent non détectées v1.
 *   - On extrait UN cycle par SCC, pas tous. Pour les SCC larges, le champ
 *     `sccSize` révèle qu'il y a plus qu'un simple aller-retour.
 */

import { Project, SyntaxKind, type Node, type SourceFile } from 'ts-morph'
import { createHash } from 'node:crypto'
import * as path from 'node:path'
import type { Cycle, CycleEdge, CycleGate, EdgeType, GraphEdge } from '../core/types.js'

export interface CyclesOptions {
  /** Types d'edges inclus dans le graphe analysé. Default : import / event / queue / dynamic-load. */
  edgeTypes?: EdgeType[]
  /**
   * Patterns de noms de gates (matching syntaxique sur le rightmost identifier
   * du callee). Un pattern terminant par `*` est un préfixe.
   * Default : ['isAllowed', 'canExecute', 'peerReview', 'checkTrust', 'guardrail*'].
   */
  gateNames?: string[]
}

const DEFAULT_EDGE_TYPES: EdgeType[] = ['import', 'event', 'queue', 'dynamic-load']
const DEFAULT_GATE_NAMES = ['isAllowed', 'canExecute', 'peerReview', 'checkTrust', 'guardrail*']

interface CycleGraph {
  adj: Map<string, Set<string>>
  edgeIndex: Map<string, GraphEdge[]>
}

/**
 * Multi-edges possibles (meme from→to via event + import) : on les garde
 * tous pour restituer les labels dans le cycle, mais pour la SCC on
 * deduplique au niveau des paires (from, to).
 */
function buildCycleGraph(
  allEdges: GraphEdge[],
  edgeTypes: Set<string>,
  fileSet: Set<string>,
): CycleGraph {
  const adj = new Map<string, Set<string>>()
  const edgeIndex = new Map<string, GraphEdge[]>()
  for (const e of allEdges) {
    if (!edgeTypes.has(e.type)) continue
    if (!fileSet.has(e.from) || !fileSet.has(e.to)) continue
    if (e.from === e.to) continue  // self-loops → pas un cycle systeme
    if (!adj.has(e.from)) adj.set(e.from, new Set())
    adj.get(e.from)!.add(e.to)
    const key = `${e.from}→${e.to}`
    if (!edgeIndex.has(key)) edgeIndex.set(key, [])
    edgeIndex.get(key)!.push(e)
  }
  return { adj, edgeIndex }
}

function buildCycleEdges(path: string[], edgeIndex: Map<string, GraphEdge[]>): CycleEdge[] {
  const edges: CycleEdge[] = []
  for (let i = 0; i < path.length - 1; i++) {
    const candidates = edgeIndex.get(`${path[i]}→${path[i + 1]}`) ?? []
    const chosen = pickRepresentativeEdge(candidates)
    if (chosen) {
      edges.push({
        from: chosen.from,
        to: chosen.to,
        type: chosen.type,
        ...(chosen.label ? { label: chosen.label } : {}),
      })
    }
  }
  return edges
}

function buildCycleFromScc(
  scc: string[],
  graph: CycleGraph,
  rootDir: string,
  project: Project,
  gateNames: string[],
): Cycle | null {
  const sccSet = new Set(scc)
  const start = [...scc].sort()[0]
  const path = findCycleInScc(start, graph.adj, sccSet)
  if (!path) return null  // SCC size >= 2 ⇒ cycle exists, theoretically unreachable

  const edges = buildCycleEdges(path, graph.edgeIndex)
  const gates = detectGates([...new Set(path)], rootDir, project, gateNames)

  return {
    id: hashCycleId(scc),
    nodes: path,
    edges,
    gated: gates.length > 0,
    gates,
    size: path.length - 1,  // exclut la repetition du noeud de depart
    sccSize: scc.length,
  }
}

/**
 * Tri deterministe : non-gated d'abord (risque plus eleve), puis par
 * taille croissante (les petits cycles sont plus actionnables), puis
 * par id pour stabilite.
 */
function sortCyclesByPriority(cycles: Cycle[]): void {
  cycles.sort((a, b) => {
    if (a.gated !== b.gated) return a.gated ? 1 : -1
    if (a.sccSize !== b.sccSize) return a.sccSize - b.sccSize
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

export async function analyzeCycles(
  rootDir: string,
  files: string[],
  allEdges: GraphEdge[],
  project: Project,
  options: CyclesOptions = {},
): Promise<Cycle[]> {
  const edgeTypes = new Set(options.edgeTypes ?? DEFAULT_EDGE_TYPES)
  const gateNames = options.gateNames ?? DEFAULT_GATE_NAMES
  const fileSet = new Set(files)

  const graph = buildCycleGraph(allEdges, edgeTypes, fileSet)
  const sccs = tarjanScc(graph.adj)

  const cycles: Cycle[] = []
  for (const scc of sccs) {
    if (scc.length < 2) continue
    const cycle = buildCycleFromScc(scc, graph, rootDir, project, gateNames)
    if (cycle) cycles.push(cycle)
  }

  sortCyclesByPriority(cycles)
  return cycles
}

// ─── Tarjan SCC (itératif) ──────────────────────────────────────────────────

/**
 * Tarjan SCC itératif — safe pour les graphes profonds. Implémentation
 * classique avec pile d'exploration explicite pour éviter l'overflow de
 * récursion sur projets larges.
 */
interface TarjanFrame {
  v: string
  successors: string[]
  nextIdx: number
}

interface TarjanState {
  adj: Map<string, Set<string>>
  index: Map<string, number>
  lowlink: Map<string, number>
  onStack: Set<string>
  stack: string[]
  sccs: string[][]
  counter: number
}

function collectTarjanNodes(adj: Map<string, Set<string>>): string[] {
  const nodes: string[] = []
  const seen = new Set<string>()
  for (const [from, tos] of adj) {
    if (!seen.has(from)) { nodes.push(from); seen.add(from) }
    for (const to of tos) {
      if (!seen.has(to)) { nodes.push(to); seen.add(to) }
    }
  }
  nodes.sort()  // ordre deterministe
  return nodes
}

function pushTarjanNode(state: TarjanState, v: string): TarjanFrame {
  state.index.set(v, state.counter)
  state.lowlink.set(v, state.counter)
  state.counter++
  state.stack.push(v)
  state.onStack.add(v)
  const successors = state.adj.has(v) ? [...state.adj.get(v)!].sort() : []
  return { v, successors, nextIdx: 0 }
}

/**
 * Successeur w de la frame en cours : si non-indexe → push child frame.
 * Si on-stack → update lowlink (back-edge to ancestor).
 */
function processTarjanSuccessor(state: TarjanState, frame: TarjanFrame, w: string, callStack: TarjanFrame[]): void {
  if (!state.index.has(w)) {
    callStack.push(pushTarjanNode(state, w))
    return
  }
  if (state.onStack.has(w)) {
    const current = state.lowlink.get(frame.v)!
    const wIdx = state.index.get(w)!
    if (wIdx < current) state.lowlink.set(frame.v, wIdx)
  }
}

/**
 * Pop scc si v est root (lowlink == index), puis pop frame + propage
 * lowlink au parent.
 */
function popTarjanFrame(state: TarjanState, v: string, callStack: TarjanFrame[]): void {
  if (state.lowlink.get(v) === state.index.get(v)) {
    const scc: string[] = []
    let w: string
    do {
      w = state.stack.pop()!
      state.onStack.delete(w)
      scc.push(w)
    } while (w !== v)
    state.sccs.push(scc.sort())
  }
  callStack.pop()
  if (callStack.length > 0) {
    const parent = callStack[callStack.length - 1]
    const pLow = state.lowlink.get(parent.v)!
    const vLow = state.lowlink.get(v)!
    if (vLow < pLow) state.lowlink.set(parent.v, vLow)
  }
}

function tarjanScc(adj: Map<string, Set<string>>): string[][] {
  const state: TarjanState = {
    adj,
    index: new Map(),
    lowlink: new Map(),
    onStack: new Set(),
    stack: [],
    sccs: [],
    counter: 0,
  }

  for (const start of collectTarjanNodes(adj)) {
    if (state.index.has(start)) continue
    const callStack: TarjanFrame[] = [pushTarjanNode(state, start)]

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1]
      if (frame.nextIdx < frame.successors.length) {
        const w = frame.successors[frame.nextIdx]
        frame.nextIdx++
        processTarjanSuccessor(state, frame, w, callStack)
      } else {
        popTarjanFrame(state, frame.v, callStack)
      }
    }
  }

  return state.sccs
}

// ─── Cycle path extraction ──────────────────────────────────────────────────

/**
 * DFS restreint aux nœuds de la SCC, cherche un path de `start` vers `start`.
 * Retourne la séquence [start, ..., start] ou null si aucun cycle (impossible
 * dans une SCC de taille ≥ 2, garde de sécurité).
 */
function findCycleInScc(
  start: string,
  adj: Map<string, Set<string>>,
  sccSet: Set<string>,
): string[] | null {
  const visited = new Set<string>()
  const stack: Array<{ node: string; path: string[] }> = [{ node: start, path: [start] }]

  while (stack.length > 0) {
    const { node, path } = stack.pop()!
    const neighbors = adj.has(node) ? [...adj.get(node)!].filter((n) => sccSet.has(n)).sort() : []
    for (const next of neighbors) {
      if (next === start && path.length >= 2) {
        return [...path, start]
      }
      if (!visited.has(next) && !path.includes(next)) {
        stack.push({ node: next, path: [...path, next] })
      }
    }
    visited.add(node)
  }

  // Fallback : SCC de taille 2, cycle direct a→b→a
  for (const a of sccSet) {
    for (const b of sccSet) {
      if (a !== b && adj.get(a)?.has(b) && adj.get(b)?.has(a)) {
        return [a, b, a]
      }
    }
  }

  return null
}

// ─── Edge selection ─────────────────────────────────────────────────────────

/**
 * Ordre de préférence pour afficher le type d'un edge dans un cycle :
 * event (le plus signifiant — c'est souvent le générateur de la boucle),
 * queue, dynamic-load, import (le plus générique). Déterministe.
 */
const EDGE_TYPE_PRIORITY: Record<EdgeType, number> = {
  event: 0,
  queue: 1,
  'dynamic-load': 2,
  route: 3,
  import: 4,
  'db-table': 5,
}

function pickRepresentativeEdge(edges: GraphEdge[]): GraphEdge | null {
  if (edges.length === 0) return null
  const sorted = [...edges].sort((a, b) => {
    const pa = EDGE_TYPE_PRIORITY[a.type] ?? 99
    const pb = EDGE_TYPE_PRIORITY[b.type] ?? 99
    if (pa !== pb) return pa - pb
    if (a.label && b.label && a.label !== b.label) return a.label < b.label ? -1 : 1
    return (a.line ?? 0) - (b.line ?? 0)
  })
  return sorted[0]
}

// ─── Gate detection ─────────────────────────────────────────────────────────

interface GatePattern {
  exact?: string
  prefix?: string  // pour `guardrail*` → prefix `guardrail`
}

function compileGatePatterns(names: string[]): GatePattern[] {
  return names.map((n) => {
    if (n.endsWith('*')) return { prefix: n.slice(0, -1) }
    return { exact: n }
  })
}

function matchGate(symbol: string, patterns: GatePattern[]): boolean {
  for (const p of patterns) {
    if (p.exact && symbol === p.exact) return true
    if (p.prefix && symbol.startsWith(p.prefix)) return true
  }
  return false
}

/**
 * Scan les fichiers du cycle pour trouver les call sites dont le callee
 * matche un pattern de gate. Retourne la liste triée par (file, line).
 */
function detectGates(
  cycleFiles: string[],
  rootDir: string,
  project: Project,
  gateNames: string[],
): CycleGate[] {
  const patterns = compileGatePatterns(gateNames)
  const gates: CycleGate[] = []

  for (const file of cycleFiles) {
    const absPath = path.join(rootDir, file)
    const sf = project.getSourceFile(absPath)
    if (!sf) continue
    gates.push(...scanGateCallsInSourceFile(sf, file, patterns))
  }

  gates.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    if (a.line !== b.line) return a.line - b.line
    return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0
  })

  return gates
}

/**
 * Helper réutilisable : scanne UN SourceFile et retourne tous les
 * call sites (CallExpression ou NewExpression) dont le callee matche
 * un des `patterns`. Réutilisé par la version Salsa.
 */
export function scanGateCallsInSourceFile(
  sf: SourceFile,
  relPath: string,
  patterns: GatePattern[],
): CycleGate[] {
  const out: CycleGate[] = []
  sf.forEachDescendant((node: Node) => {
    const k = node.getKind()
    if (k !== SyntaxKind.CallExpression && k !== SyntaxKind.NewExpression) return
    const expr = (node as any).getExpression?.()
    if (!expr) return

    let symbol: string | undefined
    if (expr.getKind() === SyntaxKind.Identifier) {
      symbol = expr.getText()
    } else if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
      symbol = (expr as any).getName?.()
    }
    if (!symbol) return
    if (!matchGate(symbol, patterns)) return

    const line = (node as any).getStartLineNumber?.() ?? 0
    out.push({ file: relPath, symbol, line })
  })
  return out
}

export {
  compileGatePatterns,
  type GatePattern,
  DEFAULT_GATE_NAMES,
  DEFAULT_EDGE_TYPES,
}

// ─── Cycle ID hashing ───────────────────────────────────────────────────────

/**
 * Hash stable d'un cycle = sha1 des nœuds triés. Survit au renommage du path
 * tant que le set de nœuds du SCC est inchangé.
 */
function hashCycleId(sccNodes: string[]): string {
  const sorted = [...sccNodes].sort().join('|')
  return createHash('sha1').update(sorted).digest('hex').slice(0, 12)
}
