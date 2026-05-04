/**
 * Time-series Lyapunov runtime (γ.2) — successeur du Lyapunov scalaire γ.1.
 *
 * Le γ.1 LyapunovRuntimeFact applique `λ = log(p95 + 1)` sur p95 isolé —
 * ce n'est PAS un vrai Lyapunov, juste un proxy "p95 élevé = chaos". Cf.
 * commentaire dans `runtime-disciplines.ts:217` : "Real Lyapunov would
 * need successive latency samples — Phase γ.2".
 *
 * Phase γ.2 : maintenant qu'on a des time-series (LatencySeriesFact, sparse
 * 1-sec buckets), on peut calculer un VRAI Lyapunov 1D simplifié à la
 * Rosenstein (1993) :
 *
 *   1. Reconstruct dense series x[0..T-1] depuis les buckets sparse.
 *   2. σ = écart-type de la série (baseline).
 *   3. Pour chaque pas t : d[t] = |x[t+1] - x[t]| / σ — divergence locale
 *      normalisée par l'écart-type.
 *   4. λ_ts = moyenne(log(1 + d[t]))  — taux moyen de divergence log.
 *
 * Interprétation :
 *   - λ_ts ≈ 0     : série stable (peu de variations bucket-to-bucket)
 *   - λ_ts ≈ 0.3   : variations modérées (~σ × 30% par pas)
 *   - λ_ts ≥ 0.7   : série très instable (variations comparable à σ)
 *   - λ_ts ≥ 1.0   : chaos majeur (variation > σ par pas)
 *
 * Différence vs scalaire γ.1 :
 *   - γ.1 : `λ = log(p95+1)` détecte "haute latence", pas la stabilité
 *   - γ.2 : `λ_ts` détecte les FLUCTUATIONS dans le temps, indépendamment
 *           du niveau absolu. Une route à 100ms steady → λ_ts ≈ 0
 *           (saine). Une route oscillant 50ms↔500ms → λ_ts élevé (malsaine).
 *
 * Sparseness handling : les buckets vides (count=0) sont dense-encoded comme 0.
 * Si une série a moins de `minObservations` buckets non-vides, on skip — la
 * statistique n'est pas fiable.
 *
 * Discipline : dynamical systems / chaos theory (Rosenstein-Collins-De Luca 1993).
 */

import type { LatencySeriesFact, RuntimeSnapshot } from '../core/types.js'

export interface LyapunovTimeseriesFact {
  kind: LatencySeriesFact['kind']
  /** Identité de la série (cf. LatencySeriesFact.key). */
  key: string
  /** Nb de buckets non-vides dans la série. */
  observations: number
  /** Écart-type des counts par bucket × 1000 (TSV-int). */
  stdDevX1000: number
  /** λ_ts × 1000 — taux de divergence moyen. > 700 = série chaotique. */
  lambdaX1000: number
}

export interface LyapunovTimeseriesOptions {
  /** Min nb de buckets non-vides pour émettre. Default: 5. */
  minObservations?: number
  /**
   * Quelle métrique projeter sur la série : 'count' (event rate) ou
   * 'meanLatencyMs' (latency stability). Default: 'meanLatencyMs' — c'est
   * la stabilité de la latence qui intéresse le plus, pas le bursty rate.
   */
  metric?: 'count' | 'meanLatencyMs'
}

const DEFAULT_OPTIONS: Required<LyapunovTimeseriesOptions> = {
  minObservations: 5,
  metric: 'meanLatencyMs',
}

/**
 * Calcule le Lyapunov 1D pour chaque série time-series du snapshot.
 * Pure — déterministe pour un snapshot donné.
 */
interface DenseSeries {
  kind: LatencySeriesFact['kind']
  key: string
  values: number[]
}

export function lyapunovTimeseries(
  snap: RuntimeSnapshot,
  options: LyapunovTimeseriesOptions = {},
): LyapunovTimeseriesFact[] {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const series = snap.latencySeries
  const bucketCount = snap.meta.bucketCount

  if (!series || series.length === 0 || !bucketCount || bucketCount < 3) {
    return []
  }

  const dense = buildDenseSeries(series, bucketCount, opts.metric)
  const out: LyapunovTimeseriesFact[] = []
  for (const ds of dense.values()) {
    const fact = computeLyapunovFact(ds, opts.minObservations)
    if (fact) out.push(fact)
  }
  out.sort(compareLyapunovFact)
  return out
}

/** Reconstruct dense series : (kind, key) → values[bucketCount]. */
function buildDenseSeries(
  series: ReadonlyArray<LatencySeriesFact>,
  bucketCount: number,
  metric: 'count' | 'meanLatencyMs',
): Map<string, DenseSeries> {
  const dense = new Map<string, DenseSeries>()
  for (const f of series) {
    const id = `${f.kind}\x00${f.key}`
    let entry = dense.get(id)
    if (!entry) {
      entry = { kind: f.kind, key: f.key, values: new Array<number>(bucketCount).fill(0) }
      dense.set(id, entry)
    }
    if (f.bucketIdx >= 0 && f.bucketIdx < bucketCount) {
      entry.values[f.bucketIdx] = metric === 'count' ? f.count : f.meanLatencyMs
    }
  }
  return dense
}

function computeLyapunovFact(
  ds: DenseSeries,
  minObservations: number,
): LyapunovTimeseriesFact | null {
  const observations = ds.values.filter((v) => v > 0).length
  if (observations < minObservations) return null

  const stdDev = computeStdDev(ds.values)
  if (stdDev === 0) {
    // Constant series — perfectly stable, λ = 0.
    return { kind: ds.kind, key: ds.key, observations, stdDevX1000: 0, lambdaX1000: 0 }
  }

  const lambda = computeLambda(ds.values, stdDev)
  return {
    kind: ds.kind,
    key: ds.key,
    observations,
    stdDevX1000: Math.floor(stdDev * 1000),
    lambdaX1000: Math.floor(lambda * 1000),
  }
}

function computeStdDev(values: number[]): number {
  const mean = values.reduce((s, x) => s + x, 0) / values.length
  const variance = values.reduce((s, x) => s + (x - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

/** λ_ts = mean over t of log(1 + |x[t+1] - x[t]| / σ). */
function computeLambda(values: number[], stdDev: number): number {
  let logSum = 0
  let stepCount = 0
  for (let t = 0; t < values.length - 1; t++) {
    const d = Math.abs(values[t + 1] - values[t]) / stdDev
    logSum += Math.log(1 + d)
    stepCount++
  }
  return stepCount === 0 ? 0 : logSum / stepCount
}

/** Determinism : lambda desc, then kind, then key. */
function compareLyapunovFact(a: LyapunovTimeseriesFact, b: LyapunovTimeseriesFact): number {
  return b.lambdaX1000 - a.lambdaX1000
    || a.kind.localeCompare(b.kind)
    || a.key.localeCompare(b.key)
}
