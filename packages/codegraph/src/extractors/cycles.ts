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

import { Project, SyntaxKind, type Node } from 'ts-morph'
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

  // ─── 1. Build adjacency list ────────────────────────────────────────

  // Multi-edges possibles (même from→to via event + import) — on les garde
  // tous pour restituer les labels dans le cycle, mais pour la SCC on
  // déduplique au niveau des paires (from, to) pour éviter de biaiser la
  // traversée.

  const adj = new Map<string, Set<string>>()  // from → set of to
  const edgeIndex = new Map<string, GraphEdge[]>()  // "from→to" → edges

  for (const e of allEdges) {
    if (!edgeTypes.has(e.type)) continue
    if (!fileSet.has(e.from) || !fileSet.has(e.to)) continue
    if (e.from === e.to) continue  // self-loops → pas un cycle système

    if (!adj.has(e.from)) adj.set(e.from, new Set())
    adj.get(e.from)!.add(e.to)

    const key = `${e.from}→${e.to}`
    if (!edgeIndex.has(key)) edgeIndex.set(key, [])
    edgeIndex.get(key)!.push(e)
  }

  // ─── 2. Tarjan SCC ──────────────────────────────────────────────────

  const sccs = tarjanScc(adj)

  // ─── 3. Cycles from SCCs ────────────────────────────────────────────

  const cycles: Cycle[] = []

  for (const scc of sccs) {
    if (scc.length < 2) continue

    // Départ stable : plus petit id (ordre lex).
    const sccSet = new Set(scc)
    const start = [...scc].sort()[0]
    const path = findCycleInScc(start, adj, sccSet)
    if (!path) continue  // theoretically unreachable (SCC size >= 2 ⇒ cycle exists)

    // Edges du path : pour chaque segment path[i] → path[i+1], prendre
    // l'edge préféré (on privilégie les types "intéressants" d'abord).
    const edges: CycleEdge[] = []
    for (let i = 0; i < path.length - 1; i++) {
      const from = path[i]
      const to = path[i + 1]
      const candidates = edgeIndex.get(`${from}→${to}`) ?? []
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

    // Gates : scan AST des fichiers du path.
    const gates = detectGates(
      [...new Set(path)],  // dédup : le premier et dernier sont identiques
      rootDir,
      project,
      gateNames,
    )

    const id = hashCycleId(scc)
    cycles.push({
      id,
      nodes: path,
      edges,
      gated: gates.length > 0,
      gates,
      size: path.length - 1,  // on exclut la répétition du nœud de départ
      sccSize: scc.length,
    })
  }

  // Tri déterministe : non-gated d'abord (risque plus élevé, plus important
  // à voir tôt dans MAP.md), puis par taille croissante (les petits cycles
  // sont plus actionnables), puis par id pour stabilité.
  cycles.sort((a, b) => {
    if (a.gated !== b.gated) return a.gated ? 1 : -1
    if (a.sccSize !== b.sccSize) return a.sccSize - b.sccSize
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  return cycles
}

// ─── Tarjan SCC (itératif) ──────────────────────────────────────────────────

/**
 * Tarjan SCC itératif — safe pour les graphes profonds. Implémentation
 * classique avec pile d'exploration explicite pour éviter l'overflow de
 * récursion sur projets larges.
 */
function tarjanScc(adj: Map<string, Set<string>>): string[][] {
  const nodes: string[] = []
  const seenNodes = new Set<string>()
  for (const [from, tos] of adj) {
    if (!seenNodes.has(from)) { nodes.push(from); seenNodes.add(from) }
    for (const to of tos) {
      if (!seenNodes.has(to)) { nodes.push(to); seenNodes.add(to) }
    }
  }
  nodes.sort()  // ordre déterministe

  const index = new Map<string, number>()
  const lowlink = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const sccs: string[][] = []
  let counter = 0

  // Frame : { v, iter: iterator over successors, pendingW?: string }
  // On simule la récursion : quand on rencontre un successeur w non-indexé,
  // on push une frame pour w et on garde track du successeur en cours.
  interface Frame {
    v: string
    successors: string[]
    nextIdx: number
  }

  for (const start of nodes) {
    if (index.has(start)) continue

    const callStack: Frame[] = []
    // init start
    index.set(start, counter)
    lowlink.set(start, counter)
    counter++
    stack.push(start)
    onStack.add(start)
    const initSuccessors = adj.has(start) ? [...adj.get(start)!].sort() : []
    callStack.push({ v: start, successors: initSuccessors, nextIdx: 0 })

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1]
      const v = frame.v

      if (frame.nextIdx < frame.successors.length) {
        const w = frame.successors[frame.nextIdx]
        frame.nextIdx++

        if (!index.has(w)) {
          index.set(w, counter)
          lowlink.set(w, counter)
          counter++
          stack.push(w)
          onStack.add(w)
          const wSuccessors = adj.has(w) ? [...adj.get(w)!].sort() : []
          callStack.push({ v: w, successors: wSuccessors, nextIdx: 0 })
        } else if (onStack.has(w)) {
          const current = lowlink.get(v)!
          const wIdx = index.get(w)!
          if (wIdx < current) lowlink.set(v, wIdx)
        }
      } else {
        // Tous les successeurs de v traités → check root
        if (lowlink.get(v) === index.get(v)) {
          const scc: string[] = []
          let w: string
          do {
            w = stack.pop()!
            onStack.delete(w)
            scc.push(w)
          } while (w !== v)
          sccs.push(scc.sort())  // tri stable à l'intérieur
        }
        callStack.pop()

        // Propager lowlink au parent si existant
        if (callStack.length > 0) {
          const parent = callStack[callStack.length - 1]
          const pLow = lowlink.get(parent.v)!
          const vLow = lowlink.get(v)!
          if (vLow < pLow) lowlink.set(parent.v, vLow)
        }
      }
    }
  }

  return sccs
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

    sf.forEachDescendant((node: Node) => {
      const k = node.getKind()
      if (k !== SyntaxKind.CallExpression && k !== SyntaxKind.NewExpression) return
      const expr = (node as any).getExpression?.()
      if (!expr) return

      // Extract the rightmost identifier : foo() → foo, obj.foo() → foo,
      // this.foo() → foo, ns.sub.foo() → foo.
      let symbol: string | undefined
      if (expr.getKind() === SyntaxKind.Identifier) {
        symbol = expr.getText()
      } else if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
        symbol = (expr as any).getName?.()
      }
      if (!symbol) return
      if (!matchGate(symbol, patterns)) return

      const line = (node as any).getStartLineNumber?.() ?? 0
      gates.push({ file, symbol, line })
    })
  }

  gates.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    if (a.line !== b.line) return a.line - b.line
    return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0
  })

  return gates
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
