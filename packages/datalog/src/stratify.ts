/**
 * Stratification de la négation.
 *
 * Pour chaque rule `Head :- ..., Body, ..., !Neg, ...` on a deux types
 * d'edges sur le graphe des relations :
 *   - positif :  Head ← Body  (Body doit être saturé avant Head)
 *   - négatif :  Head ← Neg   (Neg doit être totalement saturé avant Head,
 *                              une seule passe ne suffit pas)
 *
 * Le programme est stratifiable ssi il n'existe AUCUN cycle qui contienne
 * un edge négatif. Plus précisément (Apt-Blair-Walker) : un programme est
 * stratifié-non-récursif sur la négation ssi le graphe condensé (SCCs)
 * n'a pas de SCC de taille ≥ 2 traversée par un edge négatif. Notre
 * implémentation est plus stricte encore : on REFUSE toute récursion
 * (positive incluse) — pas nécessaire pour les ADR Sentinel actuels et ça
 * simplifie radicalement l'évaluateur.
 *
 * Cette restriction est documentée et activable via `allowRecursion=true`
 * (laissée pour future extension). Par défaut : récursion = erreur.
 *
 * Output : ordre topologique sur les SCCs (taille 1) qui devient l'ordre
 * d'exécution. Les rules sont attachées au stratum de leur head.
 *
 * Déterminisme :
 *   - Le tri topologique utilise Kahn avec une priority queue lex-ordered
 *     par nom de relation. Deux runs sur la même DB → même ordre exact.
 *   - Au sein d'un stratum, les rules sont triées par `index` (ordre
 *     d'apparition dans le source).
 */

import {
  DatalogError,
  type Program, type Rule,
} from './types.js'

export interface Stratum {
  /** Relations qui sont saturées dans ce stratum. */
  relations: string[]
  /** Rules dont le head est dans `relations` — triées par `index`. */
  rules: Rule[]
}

export interface StratifyOptions {
  /**
   * Si `true`, autorise la récursion positive. Par défaut, ne l'autorise
   * pas (échoue). La négation reste interdite en récursion dans tous les
   * cas — cf. doc.
   */
  allowRecursion?: boolean
}

export function stratify(
  program: Program,
  options: StratifyOptions = {},
): Stratum[] {
  const allowRecursion = options.allowRecursion ?? false

  const { allRels, posEdges, negEdges } = buildDependencyGraph(program)
  const combined = combineEdges(allRels, posEdges, negEdges)
  const sccs = tarjan(allRels, combined)
  validateNoBadRecursion(sccs, posEdges, negEdges, allowRecursion)
  const condensedEdges = condenseSccs(sccs, allRels, combined)
  const order = topoSortSccs(sccs, condensedEdges)
  return groupRulesByStratum(order, sccs, program.rules)
}

// ─── Phase 1: build dependency graph ────────────────────────────────────────

interface DependencyGraph {
  allRels: Set<string>
  /** posEdges[head] = set of relations head depends on (positively). */
  posEdges: Map<string, Set<string>>
  /** negEdges[head] = set of relations head depends on through `!Atom`. */
  negEdges: Map<string, Set<string>>
}

function buildDependencyGraph(program: Program): DependencyGraph {
  const allRels = new Set<string>(program.decls.keys())
  const posEdges = new Map<string, Set<string>>()
  const negEdges = new Map<string, Set<string>>()
  for (const r of allRels) {
    posEdges.set(r, new Set())
    negEdges.set(r, new Set())
  }
  for (const rule of program.rules) {
    const headRel = rule.head.rel
    for (const ba of rule.body) {
      const set = ba.negated ? negEdges.get(headRel)! : posEdges.get(headRel)!
      set.add(ba.rel)
    }
  }
  return { allRels, posEdges, negEdges }
}

// ─── Phase 2: combined graph for SCC ────────────────────────────────────────

function combineEdges(
  allRels: Set<string>,
  posEdges: Map<string, Set<string>>,
  negEdges: Map<string, Set<string>>,
): Map<string, Set<string>> {
  const combined = new Map<string, Set<string>>()
  for (const r of allRels) {
    const u: Set<string> = new Set([
      ...(posEdges.get(r) ?? []),
      ...(negEdges.get(r) ?? []),
    ])
    combined.set(r, u)
  }
  return combined
}

// ─── Phase 3: validate stratification ───────────────────────────────────────

function validateNoBadRecursion(
  sccs: string[][],
  posEdges: Map<string, Set<string>>,
  negEdges: Map<string, Set<string>>,
  allowRecursion: boolean,
): void {
  for (const scc of sccs) {
    if (scc.length === 1) {
      validateSingletonScc(scc[0], posEdges, negEdges, allowRecursion)
    } else {
      validateMutualScc(scc, negEdges, allowRecursion)
    }
  }
}

function validateSingletonScc(
  self: string,
  posEdges: Map<string, Set<string>>,
  negEdges: Map<string, Set<string>>,
  allowRecursion: boolean,
): void {
  const selfLoopPos = posEdges.get(self)?.has(self) ?? false
  const selfLoopNeg = negEdges.get(self)?.has(self) ?? false
  if (selfLoopNeg) {
    throw new DatalogError('stratify.negationInRecursion',
      `relation '${self}' depends on itself through a negated atom`)
  }
  if (selfLoopPos && !allowRecursion) {
    throw new DatalogError('stratify.recursionDisallowed',
      `relation '${self}' is recursive (self-loop) — not supported by default`)
  }
}

function validateMutualScc(
  scc: string[],
  negEdges: Map<string, Set<string>>,
  allowRecursion: boolean,
): void {
  if (!allowRecursion) {
    throw new DatalogError('stratify.recursionDisallowed',
      `mutual recursion between [${scc.sort().join(', ')}] — not supported by default`)
  }
  // Allowed : but still no negation inside.
  const sccSet = new Set(scc)
  for (const r of scc) {
    for (const dep of negEdges.get(r) ?? []) {
      if (sccSet.has(dep)) {
        throw new DatalogError('stratify.negationInRecursion',
          `negation cycle within SCC [${scc.sort().join(', ')}]`)
      }
    }
  }
}

// ─── Phase 4a: condense SCCs into a DAG ─────────────────────────────────────

function condenseSccs(
  sccs: string[][],
  allRels: Set<string>,
  combined: Map<string, Set<string>>,
): Map<number, Set<number>> {
  const sccOf = new Map<string, number>()
  sccs.forEach((scc, i) => { for (const r of scc) sccOf.set(r, i) })

  const condensedEdges = new Map<number, Set<number>>()
  for (let i = 0; i < sccs.length; i++) condensedEdges.set(i, new Set())
  for (const r of allRels) {
    const me = sccOf.get(r)!
    for (const dep of combined.get(r) ?? []) {
      const them = sccOf.get(dep)
      if (them === undefined) continue                      // ref to undeclared (caught earlier)
      if (them !== me) condensedEdges.get(me)!.add(them)
    }
  }
  return condensedEdges
}

// ─── Phase 4b: topological sort over the condensed DAG ──────────────────────

/**
 * Kahn's algorithm with deterministic tie-breaking on lex(SCC label).
 * SCC label = sorted list of relation names — total + stable.
 *
 * `condensedEdges[head]` = set of deps : head DEPENDS ON dep.
 * For topological order we want deps emitted BEFORE heads, so we walk
 * the reverse graph dep → head with `reversed`, and use `deps.size` as
 * the in-degree.
 */
function topoSortSccs(
  sccs: string[][],
  condensedEdges: Map<number, Set<number>>,
): number[] {
  const inDeg = new Map<number, number>()
  const reversed = new Map<number, number[]>()
  for (let i = 0; i < sccs.length; i++) {
    inDeg.set(i, condensedEdges.get(i)!.size)
    reversed.set(i, [])
  }
  for (const [head, deps] of condensedEdges) {
    for (const dep of deps) reversed.get(dep)!.push(head)
  }

  const labelOf = (i: number): string => sccs[i].slice().sort().join(',')

  const ready: number[] = []
  for (const [i, d] of inDeg) if (d === 0) ready.push(i)
  ready.sort((a, b) => {
    const la = labelOf(a), lb = labelOf(b)
    return la < lb ? -1 : la > lb ? 1 : 0
  })

  const order: number[] = []
  while (ready.length > 0) {
    const next = ready.shift()!
    order.push(next)
    for (const succ of reversed.get(next)!) {
      const d = inDeg.get(succ)! - 1
      inDeg.set(succ, d)
      if (d === 0) insertSortedByLabel(ready, succ, labelOf)
    }
  }
  if (order.length !== sccs.length) {
    /* istanbul ignore next: caught by recursion check above */
    throw new DatalogError('stratify.cyclesRemain',
      'topological order failed — internal invariant broken')
  }
  return order
}

/** Insère `val` dans `arr` (déjà trié par label) en préservant l'ordre lex. */
function insertSortedByLabel(
  arr: number[],
  val: number,
  labelOf: (i: number) => string,
): void {
  const lbl = labelOf(val)
  let lo = 0, hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (labelOf(arr[mid]) < lbl) lo = mid + 1
    else hi = mid
  }
  arr.splice(lo, 0, val)
}

// ─── Phase 5: group rules by stratum ────────────────────────────────────────

function groupRulesByStratum(
  order: number[],
  sccs: string[][],
  rules: Rule[],
): Stratum[] {
  const strata: Stratum[] = []
  for (const sccIdx of order) {
    const rels = sccs[sccIdx].slice().sort()
    const relSet = new Set(rels)
    const stratumRules = rules
      .filter((r) => relSet.has(r.head.rel))
      .slice()
      .sort((a, b) => a.index - b.index)
    strata.push({ relations: rels, rules: stratumRules })
  }
  return strata
}

// ─── Tarjan SCC ────────────────────────────────────────────────────────────

/**
 * Standard Tarjan SCC. Iterative-friendly mais ici récursif (la profondeur
 * max = nombre de relations, qui ne dépasse pas une centaine en pratique).
 *
 * Itère les nodes dans l'ordre lex pour que l'output (l'index des SCCs) soit
 * stable run à run.
 */
function tarjan(
  nodes: Set<string>,
  edges: Map<string, Set<string>>,
): string[][] {
  const sortedNodes = [...nodes].sort()

  let nextIndex = 0
  const indexMap = new Map<string, number>()
  const lowlink = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const sccs: string[][] = []

  function strongconnect(v: string): void {
    indexMap.set(v, nextIndex)
    lowlink.set(v, nextIndex)
    nextIndex++
    stack.push(v)
    onStack.add(v)

    const succs = [...(edges.get(v) ?? [])].sort()
    for (const w of succs) {
      if (!indexMap.has(w)) {
        strongconnect(w)
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!))
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indexMap.get(w)!))
      }
    }

    if (lowlink.get(v) === indexMap.get(v)) {
      const scc: string[] = []
      while (true) {
        const w = stack.pop()!
        onStack.delete(w)
        scc.push(w)
        if (w === v) break
      }
      sccs.push(scc.sort())
    }
  }

  for (const v of sortedNodes) {
    if (!indexMap.has(v)) strongconnect(v)
  }

  return sccs
}
