/**
 * Phase γ — disciplines mathématiques runtime.
 *
 * Porte les disciplines codegraph statique sur les facts runtime.
 * Chaque discipline produit une nouvelle relation datalog que les rules
 * γ consomment pour signaler des phénomènes mathématiquement caractérisés.
 *
 * Phase γ.1 (this file) — 4 disciplines first batch :
 *   1. **Hamming distance** statique↔runtime — quantifie le drift
 *      structurel entre call graph statique et call graph effectif
 *   2. **Information Bottleneck** runtime — chokepoints I/O dans le
 *      flow d'exécution (basé sur le ratio entropie sortante/entrante)
 *   3. **Newman-Girvan modularity** runtime — communautés effectives au
 *      runtime (qui s'appelle qui en pratique) vs déclarées au statique
 *   4. **Lyapunov exponent** sur latences — instabilité quantifiée de la
 *      distribution p95/p50 (chaos local du runtime)
 *
 * Toutes les fonctions sont PURES (snapshot in → array out) — facile à
 * tester unitairement, déterministes pour le même input.
 */

import type { RuntimeSnapshot } from '../core/types.js'
import {
  grangerRuntime,
  grangerRuntimeFileRollup,
  type GrangerRuntimeFact,
  type GrangerRuntimeFileFact,
  type GrangerRuntimeOptions,
} from './granger-runtime.js'
import {
  lyapunovTimeseries,
  type LyapunovTimeseriesFact,
  type LyapunovTimeseriesOptions,
} from './lyapunov-timeseries.js'

// ─── 1. HAMMING DISTANCE (statique ↔ runtime) ───────────────────────────

/**
 * Static call edges déclarés dans le code (depuis le SymbolCallEdge.facts
 * statique). Un edge = (fromFile, fromFn, toFile, toFn).
 */
export interface StaticCallEdge {
  fromFile: string
  fromFn: string
  toFile: string
  toFn: string
}

/**
 * Hamming distance globale entre l'ensemble des edges statiques et l'ensemble
 * des edges runtime (CallEdgeRuntime). 0 = parfaitement aligné, 1 = totalement
 * divergent. Utile comme alarme globale "drift élevé".
 *
 * Formule : |edges_only_in_static ∪ edges_only_in_runtime| / |edges_static ∪ edges_runtime|
 */
export function hammingStaticRuntime(
  snap: RuntimeSnapshot,
  staticEdges: StaticCallEdge[],
): { distance: number; staticOnly: number; runtimeOnly: number; total: number } {
  const keyOf = (e: { fromFile: string; fromFn: string; toFile: string; toFn: string }) =>
    `${e.fromFile}::${e.fromFn}->${e.toFile}::${e.toFn}`

  const staticSet = new Set(staticEdges.map(keyOf))
  const runtimeSet = new Set(snap.callEdges.map(keyOf))

  const union = new Set([...staticSet, ...runtimeSet])
  let staticOnly = 0
  let runtimeOnly = 0
  for (const k of union) {
    const inStatic = staticSet.has(k)
    const inRuntime = runtimeSet.has(k)
    if (inStatic && !inRuntime) staticOnly++
    else if (!inStatic && inRuntime) runtimeOnly++
  }
  const total = union.size
  const distance = total === 0 ? 0 : (staticOnly + runtimeOnly) / total

  return { distance, staticOnly, runtimeOnly, total }
}

// ─── 2. INFORMATION BOTTLENECK (runtime) ─────────────────────────────────

/**
 * Pour chaque (file, fn) avec spans capturés, calcule un score "bottleneck" :
 *   - Inflow  : nombre d'edges runtime entrants (callers distincts)
 *   - Outflow : nombre d'edges runtime sortants (callees distincts)
 *   - Score   : 1 - outflow / inflow  → plus c'est haut, plus le node
 *               compresse l'info entrante (chokepoint suspect).
 *
 * Inspiré du Information Bottleneck principle (Tishby) appliqué au call
 * graph dynamique au lieu de distribution P(Y|X).
 */
export interface InformationBottleneckRuntimeFact {
  file: string
  fn: string
  inflow: number
  outflow: number
  bottleneckScore: number                                              // 0..1, score *100 puis floor pour facts TSV
}

export function informationBottleneckRuntime(
  snap: RuntimeSnapshot,
): InformationBottleneckRuntimeFact[] {
  const inflow = new Map<string, Set<string>>()                        // toKey → Set(fromKey)
  const outflow = new Map<string, Set<string>>()                       // fromKey → Set(toKey)

  for (const e of snap.callEdges) {
    const fromKey = `${e.fromFile}::${e.fromFn}`
    const toKey = `${e.toFile}::${e.toFn}`
    if (!inflow.has(toKey)) inflow.set(toKey, new Set())
    inflow.get(toKey)!.add(fromKey)
    if (!outflow.has(fromKey)) outflow.set(fromKey, new Set())
    outflow.get(fromKey)!.add(toKey)
  }

  const out: InformationBottleneckRuntimeFact[] = []
  for (const sym of snap.symbolsTouched) {
    const key = `${sym.file}::${sym.fn}`
    const inSize = inflow.get(key)?.size ?? 0
    const outSize = outflow.get(key)?.size ?? 0
    if (inSize === 0) continue                                          // pas un node intéressant (pas de caller)
    const ratio = inSize === 0 ? 0 : outSize / inSize
    const bottleneckScore = Math.max(0, 1 - ratio)
    out.push({ file: sym.file, fn: sym.fn, inflow: inSize, outflow: outSize, bottleneckScore })
  }

  return out
}

// ─── 3. NEWMAN-GIRVAN MODULARITY (runtime) ──────────────────────────────

/**
 * Computes file-level modularity score for the runtime call graph.
 * On groupe les symboles par fichier (community = file) puis on calcule :
 *
 *   Q = (1/2m) Σ [A_ij - k_i*k_j/(2m)] δ(c_i, c_j)
 *
 * où :
 *   - A_ij : 1 si edge runtime entre i et j (sinon 0)
 *   - k_i  : degree de i (in + out edges)
 *   - 2m   : 2× nombre total d'edges
 *   - δ    : 1 si c_i == c_j (même file), sinon 0
 *
 * Q ∈ [-1, 1]. Q proche de 1 = communautés bien définies (flux runtime
 * concentré dans chaque file), Q proche de 0 = mélange aléatoire.
 *
 * Phase γ.1 : retourne un score global Q + composition par file. Les rules
 * peuvent flagger des files où Q chute drastiquement vs baseline statique.
 */
export interface NewmanGirvanRuntimeFact {
  globalQ: number
  filesByModularity: Array<{ file: string; q: number; symbolsCount: number }>
}

export function newmanGirvanRuntime(snap: RuntimeSnapshot): NewmanGirvanRuntimeFact {
  // Build symbol → file map
  const symbolFile = new Map<string, string>()
  for (const s of snap.symbolsTouched) {
    symbolFile.set(`${s.file}::${s.fn}`, s.file)
  }

  // Build adjacency from call edges (treat as undirected for community)
  const edges: Array<[string, string]> = []
  for (const e of snap.callEdges) {
    const a = `${e.fromFile}::${e.fromFn}`
    const b = `${e.toFile}::${e.toFn}`
    if (!symbolFile.has(a)) symbolFile.set(a, e.fromFile)
    if (!symbolFile.has(b)) symbolFile.set(b, e.toFile)
    edges.push([a, b])
  }

  const m = edges.length
  if (m === 0) return { globalQ: 0, filesByModularity: [] }

  // Compute degrees
  const degree = new Map<string, number>()
  for (const [a, b] of edges) {
    degree.set(a, (degree.get(a) ?? 0) + 1)
    degree.set(b, (degree.get(b) ?? 0) + 1)
  }

  // Q = (1/2m) Σ_ij [A_ij - k_i*k_j/(2m)] δ(c_i, c_j)
  // Pour edges réels (A_ij = 1) : contribute 1 - k_i*k_j/(2m) si même community
  // Pour non-edges (A_ij = 0) : contribute -k_i*k_j/(2m) si même community
  // Mais énumérer non-edges = O(N²). On utilise la formule simplifiée :
  //   Q = Σ_c [ (l_c / m) - (d_c / 2m)² ]
  // où l_c = edges intra-community, d_c = somme des degrees intra-community.

  const fileEdgeCount = new Map<string, number>()
  const fileDegree = new Map<string, number>()

  for (const [a, b] of edges) {
    const fa = symbolFile.get(a)!
    const fb = symbolFile.get(b)!
    if (fa === fb) {
      fileEdgeCount.set(fa, (fileEdgeCount.get(fa) ?? 0) + 1)
    }
  }
  for (const [sym, deg] of degree) {
    const file = symbolFile.get(sym)!
    fileDegree.set(file, (fileDegree.get(file) ?? 0) + deg)
  }

  const twoM = 2 * m
  let Q = 0
  const filesByModularity: NewmanGirvanRuntimeFact['filesByModularity'] = []

  // Group files
  const fileSymbols = new Map<string, Set<string>>()
  for (const [sym, file] of symbolFile) {
    if (!fileSymbols.has(file)) fileSymbols.set(file, new Set())
    fileSymbols.get(file)!.add(sym)
  }

  for (const [file, syms] of fileSymbols) {
    const lc = fileEdgeCount.get(file) ?? 0
    const dc = fileDegree.get(file) ?? 0
    const fileQ = (lc / m) - Math.pow(dc / twoM, 2)
    Q += fileQ
    filesByModularity.push({ file, q: fileQ, symbolsCount: syms.size })
  }

  // Sort for determinism (high-Q first)
  filesByModularity.sort((a, b) => b.q - a.q || a.file.localeCompare(b.file))

  return { globalQ: Q, filesByModularity }
}

// ─── 4. LYAPUNOV EXPONENT (latency stability) ───────────────────────────

/**
 * Approximate Lyapunov exponent on observed p95/p50 latencies.
 * Quantifie le chaos local : si p95/p50 explose, c'est un signal de
 * sensibilité aux conditions initiales (instabilité runtime).
 *
 * Formule simplifiée (vrai Lyapunov demande série temporelle) :
 *   λ = log(p95 / p50) / 1
 * Pour un système stable avec distribution centrée, p95/p50 ≈ 1.5-2 → λ ≈ 0.4-0.7.
 * Si p95/p50 > 5 → λ > 1.6 → chaos majeur (latence cliffs).
 *
 * Phase γ.1 : on a un seul (count, p95) par symbol, pas de série temporelle.
 * On approxime via p95/median observée — pas un VRAI Lyapunov mais un proxy
 * utile. Phase γ.2 ajoutera time-series sampling pour vrai computation.
 */
export interface LyapunovRuntimeFact {
  file: string
  fn: string
  p95LatencyMs: number
  count: number
  approxLambda: number                                                 // log(p95+1) — approximation Phase γ.1
}

export function lyapunovRuntime(snap: RuntimeSnapshot): LyapunovRuntimeFact[] {
  return snap.symbolsTouched
    .filter(s => s.p95LatencyMs > 0 && s.count >= 3)                   // need ≥3 invocations for meaningful p95
    .map(s => ({
      file: s.file,
      fn: s.fn,
      p95LatencyMs: s.p95LatencyMs,
      count: s.count,
      // log(p95 + 1) en approximation. La +1 évite log(0). Real Lyapunov
      // would need successive latency samples — Phase γ.2.
      approxLambda: Math.log(s.p95LatencyMs + 1),
    }))
}

// ─── Aggregator ──────────────────────────────────────────────────────────

/**
 * Compute toutes les disciplines runtime pour un snapshot. Helper unique
 * appelé par l'exporter γ.
 */
export interface AllDisciplinesResult {
  hamming: ReturnType<typeof hammingStaticRuntime> | null
  informationBottleneck: InformationBottleneckRuntimeFact[]
  newmanGirvan: NewmanGirvanRuntimeFact
  /** Scalar Lyapunov γ.1 (per-symbol p95-based proxy). */
  lyapunov: LyapunovRuntimeFact[]
  /** Phase γ.2 — empty si snap.latencySeries absent (compat α/β). */
  granger: GrangerRuntimeFact[]
  /** Phase γ.2 — file-level rollup pour cross-validation avec static GrangerCausality. */
  grangerFile: GrangerRuntimeFileFact[]
  /** Phase γ.2 — time-series Lyapunov 1D (Rosenstein-style sur LatencySeries). */
  lyapunovTs: LyapunovTimeseriesFact[]
}

export interface ComputeAllDisciplinesOptions {
  granger?: GrangerRuntimeOptions
  lyapunovTs?: LyapunovTimeseriesOptions
}

export function computeAllDisciplines(
  snap: RuntimeSnapshot,
  staticEdges: StaticCallEdge[] = [],
  options: ComputeAllDisciplinesOptions = {},
): AllDisciplinesResult {
  const granger = grangerRuntime(snap, options.granger)
  return {
    hamming: staticEdges.length > 0 ? hammingStaticRuntime(snap, staticEdges) : null,
    informationBottleneck: informationBottleneckRuntime(snap),
    newmanGirvan: newmanGirvanRuntime(snap),
    lyapunov: lyapunovRuntime(snap),
    granger,
    grangerFile: grangerRuntimeFileRollup(granger),
    lyapunovTs: lyapunovTimeseries(snap, options.lyapunovTs),
  }
}

export type {
  GrangerRuntimeFact,
  GrangerRuntimeFileFact,
  GrangerRuntimeOptions,
} from './granger-runtime.js'

export type {
  LyapunovTimeseriesFact,
  LyapunovTimeseriesOptions,
} from './lyapunov-timeseries.js'
