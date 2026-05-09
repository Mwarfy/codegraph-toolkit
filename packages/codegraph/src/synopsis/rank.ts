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
  // 1. Filter file nodes only (skip directories)
  const files: string[] = snapshot.nodes
    .filter((n) => n.type === 'file')
    .map((n) => n.id)

  if (files.length === 0) return []

  // 2. Build weighted directed edge list
  type Edge = { from: string; to: string; weight: number }
  const edges: Edge[] = []

  // 2a. Import edges (weight 1)
  // Direction : importer → imported (so importance flows toward
  // commonly-imported files, à la PageRank classique).
  const importEdges = snapshot.edges.filter((e) => e.type === 'import')
  for (const e of importEdges) {
    edges.push({ from: e.from, to: e.to, weight: 1 })
  }

  // 2b. Co-change edges (bidirectional, weight = jaccard * config)
  const coChangeWeight = options.coChangeWeight ?? DEFAULT_CO_CHANGE_WEIGHT
  for (const p of snapshot.coChangePairs ?? []) {
    const w = (p.jaccard ?? 0) * coChangeWeight
    if (w > 0) {
      edges.push({ from: p.from, to: p.to, weight: w })
      edges.push({ from: p.to, to: p.from, weight: w })
    }
  }

  // 3. Build personalization vector + reasons map
  const personalization = new Map<string, number>()
  const reasons = new Map<string, string[]>()

  function addReason(file: string, reason: string): void {
    let arr = reasons.get(file)
    if (!arr) {
      arr = []
      reasons.set(file, arr)
    }
    if (!arr.includes(reason)) arr.push(reason)
  }

  function addPersonalization(file: string, weight: number): void {
    personalization.set(file, (personalization.get(file) ?? 0) + weight)
  }

  // 3a. Focus files
  for (const f of options.focus) {
    addPersonalization(f, FOCUS_BOOST)
    addReason(f, 'focus')
  }

  // 3b. 1-hop neighbors of focus (importers + imports)
  const focusSet = new Set(options.focus)
  for (const e of importEdges) {
    if (focusSet.has(e.from)) {
      addPersonalization(e.to, NEIGHBOR_BOOST)
      addReason(e.to, `imported by ${basename(e.from)}`)
    }
    if (focusSet.has(e.to)) {
      addPersonalization(e.from, NEIGHBOR_BOOST)
      addReason(e.from, `imports ${basename(e.to)}`)
    }
  }

  // 3c. Co-change partners of focus (top 5 per focus file by jaccard)
  for (const f of options.focus) {
    const partners = (snapshot.coChangePairs ?? [])
      .filter((p) => p.from === f || p.to === f)
      .map((p) => ({
        other: p.from === f ? p.to : p.from,
        count: p.count,
        jaccard: p.jaccard,
      }))
      .sort((a, b) => b.jaccard - a.jaccard)
      .slice(0, 5)
    for (const p of partners) {
      const boost = CO_CHANGE_FOCUS_BOOST * p.jaccard
      addPersonalization(p.other, boost)
      addReason(p.other, `co-change j=${p.jaccard.toFixed(2)} with ${basename(f)}`)
    }
  }

  // 3d. Recently modified files
  for (const f of options.recentlyModified ?? []) {
    if (focusSet.has(f)) continue // déjà boosté en focus
    addPersonalization(f, RECENT_BOOST)
    addReason(f, 'recently modified')
  }

  // 4. Run personalized PageRank
  const ranks = pagerank(files, edges, personalization, {
    damping: options.damping ?? DEFAULT_DAMPING,
    iterations: options.iterations ?? DEFAULT_ITERATIONS,
    tolerance: options.tolerance ?? DEFAULT_TOLERANCE,
  })

  // 5. Build sorted output
  const out: RankedFile[] = files
    .map((file) => ({
      file,
      score: ranks.get(file) ?? 0,
      reasons: reasons.get(file) ?? [],
    }))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))

  // 6. Annotate "structural hub" for top files without explicit reasons.
  // Un fichier qui remonte sans match focus/neighbor/co-change est high
  // PageRank par sa centralité du graph — utile à savoir.
  for (const r of out.slice(0, 30)) {
    if (r.reasons.length === 0) r.reasons.push('structural hub')
  }

  return out
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
  edges: Array<{ from: string; to: string; weight: number }>,
  personalization: Map<string, number>,
  opts: PageRankOpts,
): Map<string, number> {
  const n = nodes.length
  const idx = new Map<string, number>()
  for (let i = 0; i < n; i++) idx.set(nodes[i], i)

  // Outgoing edges per node + total outgoing weight (for normalization)
  const outEdges: Array<Array<{ to: number; weight: number }>> = []
  for (let i = 0; i < n; i++) outEdges.push([])
  const outSum = new Array<number>(n).fill(0)
  for (const e of edges) {
    const fi = idx.get(e.from)
    const ti = idx.get(e.to)
    if (fi === undefined || ti === undefined) continue
    outEdges[fi].push({ to: ti, weight: e.weight })
    outSum[fi] += e.weight
  }

  // Personalization vector (normalized to sum 1).
  // Fallback : uniform si rien personnalisé.
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

  let rank = new Array<number>(n).fill(1 / n)

  for (let iter = 0; iter < opts.iterations; iter++) {
    const newRank = new Array<number>(n).fill(0)
    let danglingMass = 0

    for (let i = 0; i < n; i++) {
      if (outSum[i] === 0) {
        danglingMass += rank[i]
      } else {
        const total = outSum[i]
        for (const { to, weight } of outEdges[i]) {
          newRank[to] += (opts.damping * rank[i] * weight) / total
        }
      }
    }

    // Distribute dangling mass + teleport mass via personalization.
    const teleport = (1 - opts.damping) + opts.damping * danglingMass
    for (let i = 0; i < n; i++) {
      newRank[i] += teleport * persArr[i]
    }

    // Convergence check
    let diff = 0
    for (let i = 0; i < n; i++) diff += Math.abs(newRank[i] - rank[i])
    rank = newRank
    if (diff < opts.tolerance) break
  }

  const result = new Map<string, number>()
  for (let i = 0; i < n; i++) result.set(nodes[i], rank[i])
  return result
}
