/**
 * Static-vs-runtime divergence analysis — KL divergence + Pareto.
 *
 * Comble un manque mathématique : on a deux graphes de calls (statique
 * via codegraph + runtime via cpu-profile/fn-wrap) mais on ne les compare
 * jamais quantitativement. Trois disciplines orthogonales appliquées :
 *
 *   1. **KL divergence** (théorie de l'information, Kullback-Leibler 1951)
 *      KL(P ‖ Q) = Σ P(x) × log(P(x)/Q(x))
 *      Mesure combien la distribution observée P diverge de la distribution
 *      attendue Q. Appliqué par-fichier :
 *        - P = distribution runtime des calls sortants depuis ce fichier
 *        - Q = distribution statique attendue (uniforme sur les imports)
 *      Haute KL = comportement runtime "surprenant" → soit dynamic dispatch
 *      / polymorphism, soit code statique-unreachable mais runtime-hit, soit
 *      l'inverse. Tous trois sont des signaux architecturaux à investiguer.
 *
 *   2. **Pareto cumulative** (Pareto 1896, économétrie)
 *      Trie les fns par hits desc, calcule le cumulé. Identifie le rang K
 *      au-delà duquel la cumulé atteint 80% du total. K/N petit = forte
 *      concentration, gain massif si on refactor le top K. Confirme la
 *      loi 80/20 ou la réfute (si distribution plate, aucun gain net).
 *
 *   3. **Coverage drift** (set-theoretic)
 *      Symboles statiques jamais touchés runtime ∧ vice-versa. Donne la
 *      vraie liste DEAD_FN_RUNTIME et SURPRISE_FN_RUNTIME (touchés mais
 *      pas dans le graphe statique — eval, dynamic require, prototype
 *      pollution, etc.).
 *
 * Toutes les computations sont O(N) ou O(N log N), pas de coût significatif
 * vs la lecture des facts. Output JSON-serializable pour intégration dans
 * inject-self-optim-brief.
 */

export interface CallEdgeRow {
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
}

export interface DivergenceOptions {
  staticEdges: CallEdgeRow[]
  runtimeEdges: CallEdgeRow[]
  runtimeSymbols: SymbolHotRow[]
  /** Top N candidats à retourner par catégorie. Default 5. */
  topN?: number
}

export interface FileDivergence {
  file: string
  klDivergence: number
  staticOutgoing: number
  runtimeOutgoing: number
  hint: string
}

export interface ParetoResult {
  /** Nombre de symboles qui couvrent les premiers 80% des hits. */
  rank80: number
  /** Total runtime hits. */
  totalHits: number
  /** Pourcentage des symboles qui font 80% du runtime (rank80/N × 100). */
  concentrationPercent: number
  /** Top symboles trié par hits desc. */
  topSymbols: Array<{ symbol: string; hits: number; cumulative: number }>
}

export interface CoverageDrift {
  /** Symboles statiques (file:fn) jamais touchés runtime. */
  deadInRuntime: string[]
  /** Symboles runtime non vus dans graphe statique. Eval / dynamic / closure. */
  surpriseInRuntime: string[]
}

export interface DivergenceResult {
  topDivergent: FileDivergence[]
  pareto: ParetoResult
  coverage: CoverageDrift
}

export function analyzeDivergence(opts: DivergenceOptions): DivergenceResult {
  const topN = opts.topN ?? 5
  return {
    topDivergent: computeKlPerFile(opts.staticEdges, opts.runtimeEdges).slice(0, topN),
    pareto: computeParetoConcentration(opts.runtimeSymbols),
    coverage: computeCoverageDrift(opts.staticEdges, opts.runtimeEdges, opts.runtimeSymbols),
  }
}

// ─── 1. KL divergence per file ─────────────────────────────────────────────

/**
 * KL(runtime || static) par fichier source. Treat l'ensemble des edges
 * sortants comme une distribution discrete sur les targets (toFile).
 *
 * Smoothing Laplace : on ajoute 1 à chaque count + 1 dummy target pour
 * éviter log(0) quand un toFile apparaît côté runtime mais pas statique.
 * C'est un prior uniforme faible — biais faible, divergence numérique
 * stable. L'effet est négligeable quand les counts dominent (>= 10).
 *
 * Signe de la divergence :
 *   - 0 : runtime == static (cohérent)
 *   - > 0.5 : modérément divergent (typiquement dynamic dispatch léger)
 *   - > 2 : très divergent (probable polymorphism / drift)
 */
function computeKlPerFile(
  staticEdges: CallEdgeRow[],
  runtimeEdges: CallEdgeRow[],
): FileDivergence[] {
  const staticOut = groupEdgesBySource(staticEdges)
  const runtimeOut = groupEdgesBySource(runtimeEdges)

  const allFiles = new Set([...staticOut.keys(), ...runtimeOut.keys()])
  const out: FileDivergence[] = []

  for (const file of allFiles) {
    const sMap = staticOut.get(file) ?? new Map<string, number>()
    const rMap = runtimeOut.get(file) ?? new Map<string, number>()
    if (rMap.size === 0) continue  // pas de runtime data → skip

    const targets = new Set([...sMap.keys(), ...rMap.keys()])
    const sTotal = sumValues(sMap) + targets.size  // +Laplace
    const rTotal = sumValues(rMap) + targets.size

    let kl = 0
    for (const t of targets) {
      const p = ((rMap.get(t) ?? 0) + 1) / rTotal  // runtime
      const q = ((sMap.get(t) ?? 0) + 1) / sTotal  // static
      if (p > 0) kl += p * Math.log(p / q)
    }

    out.push({
      file,
      klDivergence: kl,
      staticOutgoing: sumValues(sMap),
      runtimeOutgoing: sumValues(rMap),
      hint: classifyDivergence(kl, sumValues(sMap), sumValues(rMap)),
    })
  }

  out.sort((a, b) => b.klDivergence - a.klDivergence)
  return out
}

function groupEdgesBySource(edges: CallEdgeRow[]): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>()
  for (const e of edges) {
    let m = out.get(e.fromFile)
    if (!m) {
      m = new Map<string, number>()
      out.set(e.fromFile, m)
    }
    m.set(e.toFile, (m.get(e.toFile) ?? 0) + e.count)
  }
  return out
}

function sumValues(m: Map<string, number>): number {
  let s = 0
  for (const v of m.values()) s += v
  return s
}

function classifyDivergence(kl: number, sOut: number, rOut: number): string {
  if (sOut === 0) return `runtime emits ${rOut} calls mais 0 statique — drift / dynamic dispatch`
  if (rOut === 0) return `${sOut} calls statiques mais 0 runtime — possiblement dead path`
  if (kl > 2) return `KL=${kl.toFixed(2)} — runtime targets très différents du graphe statique`
  if (kl > 0.5) return `KL=${kl.toFixed(2)} — divergence modérée, dynamic dispatch léger`
  return `KL=${kl.toFixed(2)} — comportement cohérent`
}

// ─── 2. Pareto concentration ───────────────────────────────────────────────

function computeParetoConcentration(symbols: SymbolHotRow[]): ParetoResult {
  if (symbols.length === 0) {
    return { rank80: 0, totalHits: 0, concentrationPercent: 0, topSymbols: [] }
  }

  const sorted = [...symbols].sort((a, b) => b.count - a.count)
  const total = sorted.reduce((s, r) => s + r.count, 0)

  let cumulative = 0
  let rank80 = sorted.length
  const top: ParetoResult['topSymbols'] = []
  for (let i = 0; i < sorted.length; i++) {
    cumulative += sorted[i].count
    const pct = total > 0 ? cumulative / total : 0
    top.push({
      symbol: `${sorted[i].file}:${sorted[i].fn}`,
      hits: sorted[i].count,
      cumulative: pct,
    })
    if (pct >= 0.8 && rank80 === sorted.length) {
      rank80 = i + 1
    }
  }

  return {
    rank80,
    totalHits: total,
    concentrationPercent: sorted.length > 0 ? (rank80 / sorted.length) * 100 : 0,
    topSymbols: top.slice(0, 10),
  }
}

// ─── 3. Coverage drift ─────────────────────────────────────────────────────

function computeCoverageDrift(
  staticEdges: CallEdgeRow[],
  runtimeEdges: CallEdgeRow[],
  runtimeSymbols: SymbolHotRow[],
): CoverageDrift {
  // Build symbols set from static (callers and callees both = "exists in static")
  const staticSymbols = new Set<string>()
  for (const e of staticEdges) {
    staticSymbols.add(`${e.fromFile}:${e.fromFn}`)
    staticSymbols.add(`${e.toFile}:${e.toFn}`)
  }

  const runtimeSymbolKeys = new Set<string>()
  for (const s of runtimeSymbols) runtimeSymbolKeys.add(`${s.file}:${s.fn}`)
  for (const e of runtimeEdges) {
    runtimeSymbolKeys.add(`${e.fromFile}:${e.fromFn}`)
    runtimeSymbolKeys.add(`${e.toFile}:${e.toFn}`)
  }

  const deadInRuntime: string[] = []
  for (const s of staticSymbols) {
    if (!runtimeSymbolKeys.has(s)) deadInRuntime.push(s)
  }

  const surpriseInRuntime: string[] = []
  for (const s of runtimeSymbolKeys) {
    if (!staticSymbols.has(s)) surpriseInRuntime.push(s)
  }

  deadInRuntime.sort()
  surpriseInRuntime.sort()
  return { deadInRuntime, surpriseInRuntime }
}

// ─── Render markdown for brief injection ───────────────────────────────────

export function renderDivergenceMarkdown(result: DivergenceResult): string {
  const lines: string[] = []
  lines.push('# Static↔Runtime divergence analysis')
  lines.push('')

  // Pareto
  const p = result.pareto
  if (p.totalHits > 0) {
    lines.push(`## 📊 Pareto concentration`)
    lines.push('')
    lines.push(`**${p.rank80}** symboles couvrent 80% du runtime (${p.concentrationPercent.toFixed(1)}% du total ${result.pareto.topSymbols.length}+ symboles)`)
    if (p.concentrationPercent < 30) {
      lines.push(`→ Forte concentration : optimiser le top ${p.rank80} = gain massif`)
    } else if (p.concentrationPercent < 60) {
      lines.push(`→ Concentration modérée : top ${p.rank80} prioritaire`)
    } else {
      lines.push(`→ Distribution plate : refactor au cas par cas, pas de pic`)
    }
    lines.push('')
  }

  // KL divergence
  if (result.topDivergent.length > 0) {
    lines.push(`## 🌀 Top fichiers divergents (statique vs runtime)`)
    lines.push('')
    for (const d of result.topDivergent) {
      lines.push(`- \`${d.file}\` — ${d.hint}`)
    }
    lines.push('')
  }

  // Coverage drift summary
  const dead = result.coverage.deadInRuntime.length
  const surprise = result.coverage.surpriseInRuntime.length
  if (dead + surprise > 0) {
    lines.push(`## 🔍 Coverage drift`)
    lines.push('')
    lines.push(`- ${dead} symboles statiques jamais touchés au runtime (dead candidates)`)
    lines.push(`- ${surprise} symboles runtime hors graphe statique (dynamic / closure)`)
    lines.push('')
  }

  return lines.join('\n')
}
