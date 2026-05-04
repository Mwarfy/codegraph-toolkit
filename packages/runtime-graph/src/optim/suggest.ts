/**
 * Runtime optim suggester — analyse les facts runtime pour proposer
 * des candidates d'optimisation classés par ROI mathématique.
 *
 * Universel : marche sur n'importe quelle app qui a généré des
 * DetectorTiming.facts (via self-runtime-probe-style harness) ou des
 * SymbolTouchedRuntime + CallEdgeRuntime (via cpu-profile ou fn-wrap).
 *
 * Heuristiques mathématiques appliquées :
 *
 *   1. **High-Lyapunov target** (highest ROI)
 *      Si λ_lyap > LYAPUNOV_INSTABILITY_THRESHOLD (default 1.5) sur un
 *      détecteur avec p95 > P95_HOT_THRESHOLD (default 30ms), c'est un
 *      cliff candidat — la fonction a des cas pathologiques rares.
 *      Optim typique : early-exit sur les inputs qui déclenchent le worst-case.
 *
 *   2. **Information bottleneck (runtime)**
 *      CallEdgeRuntime où une fn a un fan-in × fan-out élevé en runtime
 *      = vrai bottleneck d'exécution (vs IB statique = approximation).
 *      Optim typique : memoization ou inlining si pure.
 *
 *   3. **High frequency × high latency hot symbol**
 *      Score = count × p95LatencyMs sur SymbolTouchedRuntime. Top scores
 *      = les plus rentables à optimiser (1ms gagné × N appels).
 *
 *   4. **Variance signal (high σ)**
 *      stdDev/mean > VARIANCE_RATIO (default 0.5) = comportement non-déterministe
 *      ou data-dependent. Candidate à profiler en COLD pour comprendre.
 *
 * Output : objet structuré + markdown human-readable. À utiliser dans un
 * post-commit hook, un CI report, ou interactivement.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export interface OptimSuggestOptions {
  /** Dossier contenant DetectorTiming.facts + SymbolTouchedRuntime.facts + CallEdgeRuntime.facts. */
  factsDir: string
  /** Seuil λ au-delà duquel un détecteur est marqué "instable". Default 1.5. */
  lyapunovThreshold?: number
  /** Seuil p95 ms au-delà duquel un détecteur est "hot". Default 30. */
  p95HotMs?: number
  /** Seuil stdDev/mean au-delà duquel le détecteur est variant. Default 0.5. */
  varianceRatio?: number
  /** Top N candidates à retourner par catégorie. Default 5. */
  topN?: number
}

export interface DetectorTimingRow {
  detector: string
  runs: number
  meanMs: number
  p95Ms: number
  stdDev: number
  lambda: number
}

export interface HotEdgeRow {
  fromFile: string
  fromFn: string
  toFile: string
  toFn: string
  count: number
}

export interface SymbolHotRow {
  file: string
  fn: string
  count: number
  p95LatencyMs: number
}

export interface OptimCandidate {
  /** Catégorie du candidate. */
  kind: 'high-lyapunov' | 'runtime-bottleneck' | 'hot-symbol' | 'high-variance'
  /** Score mathématique pour ranking (plus élevé = plus rentable). */
  score: number
  /** Cible (detector ou file:fn). */
  target: string
  /** Données brutes pour debug. */
  metrics: Record<string, number>
  /** Suggestion d'action concrète. */
  hint: string
}

export interface OptimSuggestion {
  candidates: OptimCandidate[]
  summary: {
    detectorCount: number
    hotSymbolCount: number
    callEdgeCount: number
  }
}

export async function suggestOptimizations(
  opts: OptimSuggestOptions,
): Promise<OptimSuggestion> {
  const lambdaT = opts.lyapunovThreshold ?? 1.5
  const p95Hot = opts.p95HotMs ?? 30
  const varianceR = opts.varianceRatio ?? 0.5
  const topN = opts.topN ?? 5

  const detectorTimings = await loadDetectorTimings(opts.factsDir)
  const hotSymbols = await loadHotSymbols(opts.factsDir)
  const callEdges = await loadCallEdges(opts.factsDir)

  const candidates: OptimCandidate[] = []

  candidates.push(...findHighLyapunov(detectorTimings, lambdaT, p95Hot, topN))
  candidates.push(...findHighVariance(detectorTimings, varianceR, topN))
  candidates.push(...findHotSymbols(hotSymbols, topN))
  candidates.push(...findRuntimeBottlenecks(callEdges, topN))

  // Sort all candidates by score desc
  candidates.sort((a, b) => b.score - a.score)

  return {
    candidates,
    summary: {
      detectorCount: detectorTimings.length,
      hotSymbolCount: hotSymbols.length,
      callEdgeCount: callEdges.length,
    },
  }
}

// ─── Heuristic 1 — high-Lyapunov detectors ─────────────────────────────────

function findHighLyapunov(
  rows: DetectorTimingRow[],
  lambdaThreshold: number,
  p95HotMs: number,
  topN: number,
): OptimCandidate[] {
  const out: OptimCandidate[] = []
  for (const r of rows) {
    if (r.lambda < lambdaThreshold) continue
    if (r.p95Ms < p95HotMs) continue
    // Score = (lambda - 1) × p95 — pondère les cliffs sur les hot detectors
    const score = (r.lambda - 1) * r.p95Ms
    out.push({
      kind: 'high-lyapunov',
      score,
      target: r.detector,
      metrics: { lambda: r.lambda, p95Ms: r.p95Ms, meanMs: r.meanMs },
      hint: `λ=${r.lambda.toFixed(2)}, p95=${r.p95Ms.toFixed(0)}ms vs mean=${r.meanMs.toFixed(0)}ms — chercher early-exit ou input pathological case`,
    })
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, topN)
}

// ─── Heuristic 2 — variance signal ─────────────────────────────────────────

function findHighVariance(
  rows: DetectorTimingRow[],
  varianceRatio: number,
  topN: number,
): OptimCandidate[] {
  const out: OptimCandidate[] = []
  for (const r of rows) {
    if (r.meanMs < 1) continue
    const ratio = r.stdDev / r.meanMs
    if (ratio < varianceRatio) continue
    const score = ratio * r.meanMs
    out.push({
      kind: 'high-variance',
      score,
      target: r.detector,
      metrics: { stdDev: r.stdDev, mean: r.meanMs, ratio },
      hint: `σ/μ=${ratio.toFixed(2)} — comportement data-dependent, profiler en COLD pour identifier les inputs lourds`,
    })
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, topN)
}

// ─── Heuristic 3 — hot symbols (count × latency) ───────────────────────────

function findHotSymbols(rows: SymbolHotRow[], topN: number): OptimCandidate[] {
  const out: OptimCandidate[] = []
  for (const r of rows) {
    const score = r.count * r.p95LatencyMs
    if (score < 5) continue  // skip noise
    out.push({
      kind: 'hot-symbol',
      score,
      target: `${r.file}:${r.fn}`,
      metrics: { count: r.count, p95Ms: r.p95LatencyMs },
      hint: `count=${r.count} × p95=${r.p95LatencyMs}ms — memoization ou inlining si fn pure`,
    })
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, topN)
}

// ─── Heuristic 4 — runtime bottlenecks (high fan-in × fan-out) ────────────

function findRuntimeBottlenecks(rows: HotEdgeRow[], topN: number): OptimCandidate[] {
  // Compute fan-in / fan-out per (file, fn) target
  const inDeg = new Map<string, number>()
  const outDeg = new Map<string, number>()
  for (const e of rows) {
    const fromKey = `${e.fromFile}:${e.fromFn}`
    const toKey = `${e.toFile}:${e.toFn}`
    outDeg.set(fromKey, (outDeg.get(fromKey) ?? 0) + e.count)
    inDeg.set(toKey, (inDeg.get(toKey) ?? 0) + e.count)
  }

  const out: OptimCandidate[] = []
  const allKeys = new Set([...inDeg.keys(), ...outDeg.keys()])
  for (const key of allKeys) {
    const fanIn = inDeg.get(key) ?? 0
    const fanOut = outDeg.get(key) ?? 0
    if (fanIn < 2 || fanOut < 2) continue  // skip leaves and roots
    // IB-inspired score : log(in) × log(out) à la Tishby — favorise les hubs
    const score = Math.log(fanIn + 1) * Math.log(fanOut + 1)
    out.push({
      kind: 'runtime-bottleneck',
      score,
      target: key,
      metrics: { fanIn, fanOut },
      hint: `fan-in=${fanIn}, fan-out=${fanOut} — hub runtime, candidat à factorisation ou cache si idempotent`,
    })
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, topN)
}

// ─── Loaders TSV ───────────────────────────────────────────────────────────

async function loadDetectorTimings(factsDir: string): Promise<DetectorTimingRow[]> {
  const file = path.join(factsDir, 'DetectorTiming.facts')
  const text = await readOptional(file)
  const out: DetectorTimingRow[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const cols = line.split('\t')
    if (cols.length < 6) continue
    out.push({
      detector: cols[0],
      runs: parseInt(cols[1], 10),
      meanMs: parseFloat(cols[2]),
      p95Ms: parseFloat(cols[3]),
      stdDev: parseFloat(cols[4]) / 1000,  // stored as ×1000
      lambda: parseFloat(cols[5]) / 1000,  // stored as ×1000
    })
  }
  return out
}

async function loadHotSymbols(factsDir: string): Promise<SymbolHotRow[]> {
  const file = path.join(factsDir, 'SymbolTouchedRuntime.facts')
  const text = await readOptional(file)
  const out: SymbolHotRow[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const cols = line.split('\t')
    if (cols.length < 4) continue
    out.push({
      file: cols[0],
      fn: cols[1],
      count: parseInt(cols[2], 10),
      p95LatencyMs: parseInt(cols[3], 10),
    })
  }
  return out
}

async function loadCallEdges(factsDir: string): Promise<HotEdgeRow[]> {
  const file = path.join(factsDir, 'CallEdgeRuntime.facts')
  const text = await readOptional(file)
  const out: HotEdgeRow[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const cols = line.split('\t')
    if (cols.length < 5) continue
    out.push({
      fromFile: cols[0],
      fromFn: cols[1],
      toFile: cols[2],
      toFn: cols[3],
      count: parseInt(cols[4], 10),
    })
  }
  return out
}

async function readOptional(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf-8')
  } catch {
    return ''
  }
}

// ─── Render markdown ───────────────────────────────────────────────────────

export function renderSuggestionsMarkdown(s: OptimSuggestion): string {
  const lines: string[] = []
  lines.push('# Runtime optim — candidates ranked by mathematical ROI')
  lines.push('')
  lines.push(`> Source : ${s.summary.detectorCount} detector timings, ${s.summary.hotSymbolCount} hot symbols, ${s.summary.callEdgeCount} call edges`)
  lines.push('')

  if (s.candidates.length === 0) {
    lines.push('Aucun candidate — toutes les disciplines sous les seuils. ✓')
    return lines.join('\n')
  }

  const byKind = new Map<string, OptimCandidate[]>()
  for (const c of s.candidates) {
    if (!byKind.has(c.kind)) byKind.set(c.kind, [])
    byKind.get(c.kind)!.push(c)
  }

  const kindLabels: Record<string, string> = {
    'high-lyapunov': '## ⚠ High-Lyapunov detectors (cliffs cachés)',
    'high-variance': '## σ High-variance detectors (data-dependent)',
    'hot-symbol': '## 🔥 Hot symbols (count × latency)',
    'runtime-bottleneck': '## 🌐 Runtime bottlenecks (fan-in × fan-out)',
  }

  for (const kind of ['high-lyapunov', 'runtime-bottleneck', 'hot-symbol', 'high-variance']) {
    const cs = byKind.get(kind)
    if (!cs || cs.length === 0) continue
    lines.push(kindLabels[kind])
    lines.push('')
    for (const c of cs) {
      lines.push(`- **\`${c.target}\`** — score ${c.score.toFixed(1)}`)
      lines.push(`  ${c.hint}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}
