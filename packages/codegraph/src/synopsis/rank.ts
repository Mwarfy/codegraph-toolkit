// ADR-005
/**
 * Personalized PageRank pour le ranking dynamique des fichiers selon
 * un focus conversationnel donné.
 *
 * Inspiré de Aider's repo-map (cf. comparaison strategy doc) — l'idée
 * centrale est : à chaque tour LLM, recalculer un ranking où les fichiers
 * mentionnés / actifs / 1-hop d'eux reçoivent un boost de personnalisation,
 * et la propagation PageRank diffuse cette importance le long du graph
 * d'imports.
 *
 * Ce qu'on rajoute par rapport à Aider :
 *   - les edges incluent les paires co-change (signal historique git)
 *     en plus des imports
 *   - chaque fichier ranké renvoie une liste de `reasons` explicites
 *     (pour expliquer pourquoi à l'agent)
 *   - intégration directe avec le snapshot codegraph existant —
 *     pas de tree-sitter run-time, on lit le snapshot post-commit
 *
 * API stable :
 *   rankFiles(snapshot, { focus: string[], ... }) → RankedFile[]
 */

import type { GraphSnapshot } from '../core/types.js'

export interface RankOptions {
  /**
   * Fichiers sur lesquels l'agent est en train de travailler.
   * Reçoivent le boost de personnalisation le plus fort (×100) et
   * propagent leur importance vers leurs 1-hop neighbors.
   */
  focus: string[]

  /**
   * Damping factor PageRank. Default 0.85 (standard).
   */
  damping?: number

  /**
   * Max iterations. Default 50 — convergence empirique sur snapshot de
   * 1000 nodes typiquement < 30 itérations.
   */
  iterations?: number

  /**
   * Convergence tolerance (L1 distance entre rank vectors successifs).
   * Default 1e-6.
   */
  tolerance?: number

  /**
   * Multiplier sur les edges co-change (vs import edges qui ont weight 1).
   * Default 0.3 — co-change est un signal plus faible que les imports
   * directs, mais corrèle vraiment à "ces fichiers évoluent ensemble".
   */
  coChangeWeight?: number

  /**
   * Fichiers récemment modifiés (typ. depuis `git log --since="3.weeks.ago"`).
   * Reçoivent un petit boost (×10) — soft signal de pertinence.
   */
  recentlyModified?: string[]
}

export interface RankedFile {
  /** Path relatif du fichier (matches snapshot.nodes[].id). */
  file: string

  /** Score PageRank final, normalisé (∑ scores ≈ 1). */
  score: number

  /**
   * Raisons accumulées qui ont contribué au ranking de ce fichier.
   * Permet d'expliquer à l'agent / l'utilisateur pourquoi tel fichier
   * remonte. Exemple : ["focus", "imported by analyzer.ts", "co-change j=0.55 with cli/index.ts"].
   */
  reasons: string[]
}

const DEFAULT_DAMPING = 0.85
const DEFAULT_ITERATIONS = 50
const DEFAULT_TOLERANCE = 1e-6
const DEFAULT_CO_CHANGE_WEIGHT = 0.3

const FOCUS_BOOST = 100
const NEIGHBOR_BOOST = 50
const CO_CHANGE_FOCUS_BOOST = 20
const RECENT_BOOST = 10

function basename(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? p : p.slice(i + 1)
}

/**
 * Ranke tous les fichiers d'un snapshot par pertinence vis-à-vis du
 * focus donné. Output trié par score décroissant.
 */
export function rankFiles(
  snapshot: GraphSnapshot,
  options: RankOptions,
): RankedFile[] {
  const files: string[] = snapshot.nodes
    .filter((n) => n.type === 'file')
    .map((n) => n.id)
  if (files.length === 0) return []

  // Direction des import edges : importer → imported (l'importance flue vers
  // les fichiers communément importés, à la PageRank classique).
  const importEdges = snapshot.edges.filter((e) => e.type === 'import')
  const edges = buildRankEdges(
    importEdges,
    snapshot.coChangePairs ?? [],
    options.coChangeWeight ?? DEFAULT_CO_CHANGE_WEIGHT,
  )
  const { personalization, reasons } = buildPersonalization(snapshot, importEdges, options)

  const ranks = pagerank(files, edges, personalization, {
    damping: options.damping ?? DEFAULT_DAMPING,
    iterations: options.iterations ?? DEFAULT_ITERATIONS,
    tolerance: options.tolerance ?? DEFAULT_TOLERANCE,
  })

  const out: RankedFile[] = files
    .map((file) => ({
      file,
      score: ranks.get(file) ?? 0,
      reasons: reasons.get(file) ?? [],
    }))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))

  // Annotate "structural hub" : un top fichier sans reason explicite remonte
  // par sa centralité du graph — utile à signaler à l'agent.
  for (const r of out.slice(0, 30)) {
    if (r.reasons.length === 0) r.reasons.push('structural hub')
  }
  return out
}

type RankEdge = { from: string; to: string; weight: number }

/**
 * Liste d'edges pondérés dirigés : imports (weight 1) + co-change
 * (bidirectionnel, weight = jaccard × coChangeWeight, seulement si > 0).
 */
function buildRankEdges(
  importEdges: GraphSnapshot['edges'],
  coChangePairs: NonNullable<GraphSnapshot['coChangePairs']>,
  coChangeWeight: number,
): RankEdge[] {
  const edges: RankEdge[] = []
  for (const e of importEdges) {
    edges.push({ from: e.from, to: e.to, weight: 1 })
  }
  for (const p of coChangePairs) {
    const w = (p.jaccard ?? 0) * coChangeWeight
    if (w > 0) {
      edges.push({ from: p.from, to: p.to, weight: w })
      edges.push({ from: p.to, to: p.from, weight: w })
    }
  }
  return edges
}

/** Vecteur de personnalisation + reasons accumulés. */
interface PersonalizationAcc {
  personalization: Map<string, number>
  reasons: Map<string, string[]>
}

function addReason(acc: PersonalizationAcc, file: string, reason: string): void {
  let arr = acc.reasons.get(file)
  if (!arr) {
    arr = []
    acc.reasons.set(file, arr)
  }
  if (!arr.includes(reason)) arr.push(reason)
}

function addPersonalization(acc: PersonalizationAcc, file: string, weight: number): void {
  acc.personalization.set(file, (acc.personalization.get(file) ?? 0) + weight)
}

/**
 * Construit le vecteur de personnalisation PageRank depuis le focus :
 * focus direct (×100), voisins 1-hop (×50), partenaires co-change top-5
 * (×20·jaccard), fichiers récemment modifiés (×10, sauf si déjà focus).
 */
function buildPersonalization(
  snapshot: GraphSnapshot,
  importEdges: GraphSnapshot['edges'],
  options: RankOptions,
): PersonalizationAcc {
  const acc: PersonalizationAcc = { personalization: new Map(), reasons: new Map() }
  const focusSet = new Set(options.focus)

  for (const f of options.focus) {
    addPersonalization(acc, f, FOCUS_BOOST)
    addReason(acc, f, 'focus')
  }

  for (const e of importEdges) {
    if (focusSet.has(e.from)) {
      addPersonalization(acc, e.to, NEIGHBOR_BOOST)
      addReason(acc, e.to, `imported by ${basename(e.from)}`)
    }
    if (focusSet.has(e.to)) {
      addPersonalization(acc, e.from, NEIGHBOR_BOOST)
      addReason(acc, e.from, `imports ${basename(e.to)}`)
    }
  }

  for (const f of options.focus) {
    for (const p of topCoChangePartners(snapshot.coChangePairs ?? [], f)) {
      addPersonalization(acc, p.other, CO_CHANGE_FOCUS_BOOST * p.jaccard)
      addReason(acc, p.other, `co-change j=${p.jaccard.toFixed(2)} with ${basename(f)}`)
    }
  }

  for (const f of options.recentlyModified ?? []) {
    if (focusSet.has(f)) continue
    addPersonalization(acc, f, RECENT_BOOST)
    addReason(acc, f, 'recently modified')
  }

  return acc
}

/** Top-5 partenaires co-change d'un fichier focus, triés par jaccard desc. */
function topCoChangePartners(
  coChangePairs: NonNullable<GraphSnapshot['coChangePairs']>,
  focus: string,
): Array<{ other: string; jaccard: number }> {
  return coChangePairs
    .filter((p) => p.from === focus || p.to === focus)
    .map((p) => ({ other: p.from === focus ? p.to : p.from, jaccard: p.jaccard }))
    .sort((a, b) => b.jaccard - a.jaccard)
    .slice(0, 5)
}

interface PageRankOpts {
  damping: number
  iterations: number
  tolerance: number
}

/**
 * Iterative power-method PageRank avec personalisation.
 *
 * Spécificités vs vanilla PageRank :
 *   - personalization vector au lieu de teleport uniforme — c'est ce qui
 *     fait que le ranking est "tasked" sur le focus
 *   - dangling nodes (out-degree 0) redistribuent leur masse via la
 *     personalization (standard treatment)
 *   - convergence early-exit via L1 distance
 *
 * Complexity : O(iter × |edges|) — sur Sentinel ~600 nodes / 2000 edges
 * en ~5ms.
 */
function pagerank(
  nodes: string[],
  edges: RankEdge[],
  personalization: Map<string, number>,
  opts: PageRankOpts,
): Map<string, number> {
  const n = nodes.length
  const idx = new Map<string, number>()
  for (let i = 0; i < n; i++) idx.set(nodes[i], i)

  const { outEdges, outSum } = buildAdjacency(n, idx, edges)
  const persArr = normalizedPersonalization(n, idx, personalization)
  const rank = powerIterate(n, outEdges, outSum, persArr, opts)

  const result = new Map<string, number>()
  for (let i = 0; i < n; i++) result.set(nodes[i], rank[i])
  return result
}

type AdjList = Array<Array<{ to: number; weight: number }>>

/** Listes d'adjacence sortantes + somme des poids sortants par node. */
function buildAdjacency(
  n: number,
  idx: Map<string, number>,
  edges: RankEdge[],
): { outEdges: AdjList; outSum: number[] } {
  const outEdges: AdjList = []
  for (let i = 0; i < n; i++) outEdges.push([])
  const outSum = new Array<number>(n).fill(0)
  for (const e of edges) {
    const fi = idx.get(e.from)
    const ti = idx.get(e.to)
    if (fi === undefined || ti === undefined) continue
    outEdges[fi].push({ to: ti, weight: e.weight })
    outSum[fi] += e.weight
  }
  return { outEdges, outSum }
}

/**
 * Vecteur de personnalisation normalisé (∑ = 1). Fallback uniforme (1/n)
 * si rien n'est personnalisé (focus vide).
 */
function normalizedPersonalization(
  n: number,
  idx: Map<string, number>,
  personalization: Map<string, number>,
): number[] {
  const persArr = new Array<number>(n).fill(0)
  let persSum = 0
  for (const [name, w] of personalization.entries()) {
    const i = idx.get(name)
    if (i !== undefined && w > 0) {
      persArr[i] = w
      persSum += w
    }
  }
  if (persSum === 0) {
    persArr.fill(1 / n)
  } else {
    for (let i = 0; i < n; i++) persArr[i] /= persSum
  }
  return persArr
}

/**
 * Power-method itératif : diffuse le rank le long des edges (damping), gère
 * la masse dangling + teleport via la personnalisation, early-exit sur
 * convergence L1 < tolerance.
 */
function powerIterate(
  n: number,
  outEdges: AdjList,
  outSum: number[],
  persArr: number[],
  opts: PageRankOpts,
): number[] {
  let rank = new Array<number>(n).fill(1 / n)
  for (let iter = 0; iter < opts.iterations; iter++) {
    const newRank = new Array<number>(n).fill(0)
    let danglingMass = 0

    for (let i = 0; i < n; i++) {
      if (outSum[i] === 0) {
        danglingMass += rank[i]
      } else {
        for (const { to, weight } of outEdges[i]) {
          newRank[to] += (opts.damping * rank[i] * weight) / outSum[i]
        }
      }
    }

    // Distribue la masse dangling + teleport via la personnalisation.
    const teleport = (1 - opts.damping) + opts.damping * danglingMass
    for (let i = 0; i < n; i++) {
      newRank[i] += teleport * persArr[i]
    }

    let diff = 0
    for (let i = 0; i < n; i++) diff += Math.abs(newRank[i] - rank[i])
    rank = newRank
    if (diff < opts.tolerance) break
  }
  return rank
}
