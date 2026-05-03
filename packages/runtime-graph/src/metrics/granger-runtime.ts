/**
 * Granger causality runtime — détection de causation directionnelle entre
 * paires de séries temporelles courtes (run window).
 *
 * Origine : Clive Granger 1969 (Nobel Economics 2003). X Granger-cause Y
 * si la connaissance des valeurs PASSÉES de X améliore la prédiction des
 * valeurs FUTURES de Y au-delà de ce que Y elle-même permet.
 *
 * Différenciation des disciplines runtime existantes :
 *   - InformationBottleneck (γ.1)  : score statique d'un node (in/out ratio)
 *   - NewmanGirvanModularity (γ.1) : communautés effectives au runtime
 *   - Lyapunov (γ.1, scalaire)     : chaos local d'un symbole isolé
 *   - **Granger runtime (γ.2)**    : causation entre 2 séries (drives ?)
 *
 * Application au runtime : sur les buckets time-series (LatencySeriesFact),
 * pour chaque paire (A, B), regarder la lag-1 conditional probability.
 *
 *     P(B spike at bucket t+1 | A spike at bucket t) > P(B spike at t+1)
 *
 * Si oui par marge significative = A Granger-cause B. Cela révèle les
 * dépendances séquentielles : route /api/orders qui amène un INSERT orders
 * au bucket suivant, événement video.publish qui déclenche un fetch S3
 * 1s plus tard, etc.
 *
 * Distinction critique vs Granger statique (codegraph commits) :
 *   - Granger statique : lag entre commits (jours/semaines)
 *   - Granger runtime  : lag entre événements (secondes)
 *
 * Composite cross-validation : si les deux fire sur la même paire,
 * c'est un coupling fortement vérifié — temporel ET architectural.
 *
 * Test simplifié (alignement avec l'extracteur git statique) :
 *
 *     excess = P(B at t+1 | A at t) - P(B at t+1)
 *
 * et on émet si excess ≥ minExcessConditional (default 0.15 = 15 percentage
 * points). Ratchet bayésien sur fréquence minimale (≥ minObservations spikes
 * de A) pour éviter les artefacts statistiques.
 */

import type { LatencySeriesFact, RuntimeSnapshot } from '../core/types.js'

export interface GrangerRuntimeFact {
  /** Driver — série qui spike à t. Format `<kind>:<key>`. */
  driverSeries: string
  /** Follower — série qui spike à t+1. Format `<kind>:<key>`. */
  followerSeries: string
  /** Nb de fois où driver spike a été suivi par follower spike au lag. */
  observations: number
  /**
   * Excess conditional probability × 1000 (scale ×1000 pour TSV/datalog) :
   *   P(follower spike at t+1 | driver spike at t) - P(follower spike at t+1)
   * Plus haut = causation directionnelle plus claire. > 150 = signal.
   */
  excessConditionalX1000: number
  /** Lag en buckets (γ.2 : toujours 1 pour l'instant — γ.3 supportera lag-N). */
  lagBuckets: number
}

export interface GrangerRuntimeOptions {
  /** Minimum observations driver-spike pour émettre. Default: 3. */
  minObservations?: number
  /**
   * Minimum excess conditional probability pour émettre. Default: 0.15.
   * Émet uniquement si P(B|A) - P(B) ≥ 0.15.
   */
  minExcessConditional?: number
  /**
   * Seuil "spike" : un bucket est considéré spike si son count ≥ mean(série) × spikeMultiplier.
   * Default: 1.5 (50% above mean). Plus élevé = plus strict.
   */
  spikeMultiplier?: number
  /**
   * Lag en buckets. γ.2 : 1 uniquement. γ.3 supportera lag 1..K avec
   * choix automatique du best lag.
   */
  lagBuckets?: number
}

const DEFAULT_OPTIONS: Required<GrangerRuntimeOptions> = {
  minObservations: 3,
  minExcessConditional: 0.15,
  spikeMultiplier: 1.5,
  lagBuckets: 1,
}

/**
 * Compute Granger runtime causality entre toutes les paires de séries
 * du snapshot. Pure — déterministe pour un snapshot donné.
 *
 * Complexité : O(N² × T) où N = nb séries, T = nb buckets. Pour ~50 séries
 * et 60 buckets (1 min @ 1s) → 180k ops. Négligeable.
 */
type RequiredOptions = Required<GrangerRuntimeOptions>

export function grangerRuntime(
  snap: RuntimeSnapshot,
  options: GrangerRuntimeOptions = {},
): GrangerRuntimeFact[] {
  const opts: RequiredOptions = { ...DEFAULT_OPTIONS, ...options }
  const series = snap.latencySeries
  const bucketCount = snap.meta.bucketCount

  if (!series || series.length === 0 || !bucketCount || bucketCount < opts.lagBuckets + 2) {
    return []
  }

  const densesByKey = buildDenseSeries(series, bucketCount)
  const seriesIds = Array.from(densesByKey.keys()).sort()
  const spikes = computeSpikes(densesByKey, seriesIds, bucketCount, opts.spikeMultiplier)
  const out = scanGrangerPairs(seriesIds, spikes, bucketCount, opts)
  out.sort(compareGrangerFact)
  return out
}

/** Reconstruct dense series : sparse facts → counts[bucketCount] per (kind:key) id. */
function buildDenseSeries(
  series: ReadonlyArray<{ kind: string; key: string; bucketIdx: number; count: number }>,
  bucketCount: number,
): Map<string, number[]> {
  const densesByKey = new Map<string, number[]>()
  for (const f of series) {
    const id = `${f.kind}:${f.key}`
    let arr = densesByKey.get(id)
    if (!arr) {
      arr = new Array<number>(bucketCount).fill(0)
      densesByKey.set(id, arr)
    }
    if (f.bucketIdx >= 0 && f.bucketIdx < bucketCount) {
      arr[f.bucketIdx] = f.count
    }
  }
  return densesByKey
}

/** Per series, threshold = max(1, mean × spikeMultiplier) → boolean[] mask. */
function computeSpikes(
  densesByKey: Map<string, number[]>,
  seriesIds: string[],
  bucketCount: number,
  spikeMultiplier: number,
): Map<string, boolean[]> {
  const spikes = new Map<string, boolean[]>()
  for (const id of seriesIds) {
    const arr = densesByKey.get(id)!
    const mean = arr.reduce((s, x) => s + x, 0) / bucketCount
    const threshold = Math.max(1, mean * spikeMultiplier)
    spikes.set(id, arr.map((x) => x >= threshold))
  }
  return spikes
}

/** Pour chaque pair (driver, follower), compute excess et émet si > seuil. */
function scanGrangerPairs(
  seriesIds: string[],
  spikes: Map<string, boolean[]>,
  bucketCount: number,
  opts: RequiredOptions,
): GrangerRuntimeFact[] {
  const out: GrangerRuntimeFact[] = []
  for (const driverId of seriesIds) {
    const driverSpikes = spikes.get(driverId)!
    if (driverSpikes.filter(Boolean).length < opts.minObservations) continue
    for (const followerId of seriesIds) {
      if (followerId === driverId) continue
      const followerSpikes = spikes.get(followerId)!
      const fact = computePairFact(driverId, driverSpikes, followerId, followerSpikes, bucketCount, opts)
      if (fact) out.push(fact)
    }
  }
  return out
}

/** Compute le fact pour une paire (driver, follower). null si seuils non atteints. */
function computePairFact(
  driverId: string,
  driverSpikes: boolean[],
  followerId: string,
  followerSpikes: boolean[],
  bucketCount: number,
  opts: RequiredOptions,
): GrangerRuntimeFact | null {
  const followerSpikeCount = followerSpikes.filter(Boolean).length
  if (followerSpikeCount === 0) return null
  const followerMarginal = followerSpikeCount / bucketCount

  let coOccurrences = 0
  let driverEligible = 0
  for (let t = 0; t + opts.lagBuckets < bucketCount; t++) {
    if (!driverSpikes[t]) continue
    driverEligible++
    if (followerSpikes[t + opts.lagBuckets]) coOccurrences++
  }
  if (driverEligible < opts.minObservations) return null

  const excess = coOccurrences / driverEligible - followerMarginal
  if (excess < opts.minExcessConditional) return null

  return {
    driverSeries: driverId,
    followerSeries: followerId,
    observations: coOccurrences,
    excessConditionalX1000: Math.floor(excess * 1000),
    lagBuckets: opts.lagBuckets,
  }
}

/** Determinism : excess desc, driver asc, follower asc. */
function compareGrangerFact(a: GrangerRuntimeFact, b: GrangerRuntimeFact): number {
  return b.excessConditionalX1000 - a.excessConditionalX1000
    || a.driverSeries.localeCompare(b.driverSeries)
    || a.followerSeries.localeCompare(b.followerSeries)
}

/**
 * File-level rollup pour la cross-validation avec GrangerCausality statique
 * (qui opère sur des FILES, pas des fonctions). Pour chaque paire de
 * symboles `symbol:<fileA>::<fnX> → symbol:<fileB>::<fnY>` détectée par
 * `grangerRuntime`, on projette sur (fileA, fileB) en sommant les
 * observations et en gardant le max excess.
 *
 * Évite que le datalog ait à parser `kind:key` (Soufflé string ops sont
 * lourdes) — on shippe une relation déjà projetée.
 */
export interface GrangerRuntimeFileFact {
  driverFile: string
  followerFile: string
  /** Somme des observations sur toutes les paires de fns (driver→follower). */
  observations: number
  /** Max excess parmi les paires de fns. */
  maxExcessConditionalX1000: number
}

export function grangerRuntimeFileRollup(
  facts: GrangerRuntimeFact[],
): GrangerRuntimeFileFact[] {
  const acc = new Map<string, GrangerRuntimeFileFact>()
  for (const f of facts) {
    if (!f.driverSeries.startsWith('symbol:') || !f.followerSeries.startsWith('symbol:')) continue
    const driverFile = parseSymbolFile(f.driverSeries)
    const followerFile = parseSymbolFile(f.followerSeries)
    if (!driverFile || !followerFile || driverFile === followerFile) continue
    const id = `${driverFile}\x00${followerFile}`
    let cur = acc.get(id)
    if (!cur) {
      cur = { driverFile, followerFile, observations: 0, maxExcessConditionalX1000: 0 }
      acc.set(id, cur)
    }
    cur.observations += f.observations
    if (f.excessConditionalX1000 > cur.maxExcessConditionalX1000) {
      cur.maxExcessConditionalX1000 = f.excessConditionalX1000
    }
  }
  return Array.from(acc.values()).sort((a, b) =>
    b.maxExcessConditionalX1000 - a.maxExcessConditionalX1000
      || a.driverFile.localeCompare(b.driverFile)
      || a.followerFile.localeCompare(b.followerFile),
  )
}

function parseSymbolFile(seriesId: string): string | null {
  // Format : "symbol:<file>::<fn>". On retourne <file> ou null si malformé.
  const colonIdx = seriesId.indexOf(':')
  if (colonIdx === -1) return null
  const rest = seriesId.slice(colonIdx + 1)
  const sep = rest.indexOf('::')
  if (sep === -1) return null
  return rest.slice(0, sep)
}
