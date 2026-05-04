/**
 * Wasserstein / Earth Mover's Distance — comparer 2 distributions runtime.
 *
 * Discipline : optimal transport (Monge 1781, Kantorovich 1942).
 * Mesure le coût minimum pour "transformer" une distribution en une autre.
 * Pour 1D distributions (notre cas : counts par symbol triés), W1 est
 * l'aire entre les CDFs cumulatives — calculable en O(N log N).
 *
 * Pourquoi vs runtime-diff actuel :
 *   - runtime-diff : compare per-detector (X% delta on chaque). Manque
 *     les changements de SHAPE de distribution (les hits redistribuent
 *     entre fns, total constant).
 *   - Wasserstein : capture le RESHAPING. Si après refactor les hits
 *     déplacent de fn-A vers fn-B sans changer le total, runtime-diff
 *     dit "rien à signaler" mais W1 monte.
 *
 * Usage : compare 2 SymbolTouchedRuntime captures (avant/après refactor,
 * baseline vs PR) et donne un score de divergence global + identifie les
 * "movers" (fns qui ont gagné/perdu le plus de mass).
 */

export interface DistributionRow {
  key: string  // file:fn
  weight: number  // count / hits / cumulative time
}

export interface WassersteinOptions {
  before: DistributionRow[]
  after: DistributionRow[]
  /** Top N movers à reporter. Default 10. */
  topN?: number
}

export interface MoverRow {
  key: string
  beforeWeight: number
  afterWeight: number
  delta: number
  /** % de la masse globale concernée par cette mass shift. */
  contributionPct: number
}

export interface WassersteinResult {
  /** W1 distance (Earth Mover's). 0 = distributions identiques. */
  w1Distance: number
  /** Total mass des deux distributions, utile pour normalize w1. */
  totalMassBefore: number
  totalMassAfter: number
  /** Distance normalisée par max(totalBefore, totalAfter). */
  w1Normalized: number
  /** Top symbols ayant gagné le plus de mass. */
  topGainers: MoverRow[]
  /** Top symbols ayant perdu le plus de mass. */
  topLosers: MoverRow[]
}

/**
 * W1 distance pour distributions discrètes 1D : aire entre les 2 CDFs.
 *
 * Algo :
 *   1. Union des keys, normalize les weights → probabilités
 *   2. Sort les keys (ordre canonique = ordre lex pour reproductibilité)
 *   3. CDF cumulative pour chaque distribution
 *   4. W1 = Σ |CDF_A(k) - CDF_B(k)| × Δ_k où Δ_k = espacement entre keys
 *      (ici uniforme = 1 par key, donc somme directe des |diff CDF|)
 *
 * Pour des distributions sur des keys discrètes sans ordre métrique
 * naturel (file:fn), on utilise l'ordre lex comme proxy. C'est moins
 * informatif que W1 sur un espace métrique réel, mais suffit à détecter
 * les redistributions.
 */
export function wassersteinDistance(opts: WassersteinOptions): WassersteinResult {
  const topN = opts.topN ?? 10
  const totalBefore = sum(opts.before)
  const totalAfter = sum(opts.after)
  const beforeMap = toMap(opts.before)
  const afterMap = toMap(opts.after)

  const keys = unionKeys(beforeMap, afterMap)

  // Probabilités normalisées (skip si mass=0 pour éviter NaN)
  const beforeNorm = totalBefore > 0
    ? mapValues(beforeMap, (v) => v / totalBefore)
    : new Map<string, number>()
  const afterNorm = totalAfter > 0
    ? mapValues(afterMap, (v) => v / totalAfter)
    : new Map<string, number>()

  // CDF cumulative + accumulation W1
  let cdfA = 0
  let cdfB = 0
  let w1 = 0
  for (const k of keys) {
    cdfA += beforeNorm.get(k) ?? 0
    cdfB += afterNorm.get(k) ?? 0
    w1 += Math.abs(cdfA - cdfB)
  }

  // Movers : keys avec delta absolu max
  const movers: MoverRow[] = []
  for (const k of keys) {
    const b = beforeMap.get(k) ?? 0
    const a = afterMap.get(k) ?? 0
    if (b === 0 && a === 0) continue
    const delta = a - b
    const totalMass = Math.max(totalBefore, totalAfter, 1)
    movers.push({
      key: k,
      beforeWeight: b,
      afterWeight: a,
      delta,
      contributionPct: (Math.abs(delta) / totalMass) * 100,
    })
  }

  const gainers = [...movers]
    .filter((m) => m.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, topN)
  const losers = [...movers]
    .filter((m) => m.delta < 0)
    .sort((a, b) => a.delta - b.delta)
    .slice(0, topN)

  const norm = Math.max(totalBefore, totalAfter)
  return {
    w1Distance: w1,
    w1Normalized: norm > 0 ? w1 / norm : 0,
    totalMassBefore: totalBefore,
    totalMassAfter: totalAfter,
    topGainers: gainers,
    topLosers: losers,
  }
}

function sum(rows: DistributionRow[]): number {
  return rows.reduce((s, r) => s + r.weight, 0)
}

function toMap(rows: DistributionRow[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const r of rows) m.set(r.key, (m.get(r.key) ?? 0) + r.weight)
  return m
}

function unionKeys(a: Map<string, number>, b: Map<string, number>): string[] {
  const set = new Set<string>([...a.keys(), ...b.keys()])
  return [...set].sort()
}

function mapValues(m: Map<string, number>, fn: (v: number) => number): Map<string, number> {
  const out = new Map<string, number>()
  for (const [k, v] of m) out.set(k, fn(v))
  return out
}

export function renderWassersteinMarkdown(result: WassersteinResult): string {
  const lines: string[] = []
  lines.push(`## 🌊 Wasserstein W₁ — runtime distribution shift`)
  lines.push('')
  lines.push(`W₁ = ${result.w1Distance.toFixed(3)} (normalized ${(result.w1Normalized * 100).toFixed(2)}%)`)
  lines.push('')
  lines.push(`Mass : ${result.totalMassBefore} → ${result.totalMassAfter} (${(result.totalMassAfter - result.totalMassBefore).toFixed(0)} delta)`)
  lines.push('')

  if (result.topGainers.length > 0) {
    lines.push(`### ↑ Top gainers (mass shifted vers ces fns)`)
    lines.push('')
    for (const g of result.topGainers) {
      lines.push(`- \`${g.key}\` : ${g.beforeWeight} → ${g.afterWeight} (+${g.delta}, ${g.contributionPct.toFixed(1)}%)`)
    }
    lines.push('')
  }
  if (result.topLosers.length > 0) {
    lines.push(`### ↓ Top losers (mass shifted depuis ces fns)`)
    lines.push('')
    for (const l of result.topLosers) {
      lines.push(`- \`${l.key}\` : ${l.beforeWeight} → ${l.afterWeight} (${l.delta}, ${l.contributionPct.toFixed(1)}%)`)
    }
    lines.push('')
  }
  return lines.join('\n')
}
