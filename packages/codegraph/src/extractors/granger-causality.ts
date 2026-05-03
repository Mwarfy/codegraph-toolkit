/**
 * Lag-1 conditional probability — heuristique INSPIRÉE par Granger
 * causality (Granger 1969), **pas un test de Granger formel**.
 *
 * ⚠ HONESTY DISCLAIMER : Le vrai test de Granger demande :
 *   - 2 modèles VAR (vector autoregression) imbriqués :
 *     restricted = AR(Y_t | Y_{t-1..t-k})
 *     unrestricted = AR(Y_t | Y_{t-1..t-k}, X_{t-1..t-k})
 *   - test F sur la réduction du résidu : F = ((SSR_r - SSR_ur)/k) / (SSR_ur/(N-2k-1))
 *   - p-value vs seuil α
 *   - séries TEMPORELLES régulières (Δt constant entre observations)
 *
 * Aucune de ces conditions n'est implémentée ici. De plus, les
 * "pas de temps" sont ici les commits successifs git, qui sont
 * IRRÉGULIERS (50 commits en 1 jour vs 0 commits pendant 1 mois) —
 * ce ne sont pas des time series proprement dites.
 *
 * Ce que l'extracteur calcule réellement :
 *   excess = P(B in commit t+1 | A in commit t) − P(B in commit t+1)
 *
 * C'est l'excess conditional probability d'un évènement (B modifié)
 * sachant un autre évènement à l'index commit précédent. Le nom
 * "Granger" est conservé pour cohérence backward, mais le concept
 * réel est "lag-1 commit-conditional excess probability".
 *
 * Utilité pratique (l'heuristique signal) :
 *   - excess > 0.15 (15 percentage points au-dessus du baseline) +
 *     observations ≥ 3 = pattern lag-1 reproductible : "modifier A
 *     entraîne souvent modifier B au prochain commit".
 *   - Capture les couplages séquentiels qui ne se voient pas dans
 *     un co-change lag-0 (Bayesian conditional dans le même commit).
 *
 * Différenciation vs Bayesian co-change conditional :
 *   - Bayesian P(B|A) : A et B dans le MÊME commit (lag 0)
 *   - Cet extracteur : A à index t, B à index t+1 (lag 1)
 */

import { execSync } from 'node:child_process'

export interface GrangerCausality {
  /** Driver — file qui bouge à t. */
  driverFile: string
  /** Follower — file qui bouge à t+1. */
  followerFile: string
  /** Nb de fois où driver→follower (lag 1) observé. */
  observations: number
  /**
   * Excess conditional probability × 1000 :
   *   P(follower at t+1 | driver at t) - P(follower at t+1)
   * Plus haut = causation directionnelle plus claire. > 150 = signal.
   */
  excessConditionalX1000: number
}

export interface GrangerOptions {
  sinceDays?: number
  /** Minimum d'observations pour qu'une paire soit incluse. Défaut: 3. */
  minObservations?: number
  /** Excess conditional minimal × 1000. Défaut: 150. */
  minExcessX1000?: number
  knownFiles?: Set<string>
  maxCommits?: number
  maxFilesPerCommit?: number
}

interface CommitChanges {
  files: Set<string>
}

export async function computeGrangerCausality(
  rootDir: string,
  options: GrangerOptions = {},
): Promise<GrangerCausality[]> {
  const sinceDays = options.sinceDays ?? 90
  const minObservations = options.minObservations ?? 3
  const minExcessX1000 = options.minExcessX1000 ?? 150
  const maxCommits = options.maxCommits ?? 1000
  const maxFilesPerCommit = options.maxFilesPerCommit ?? 50
  const knownFiles = options.knownFiles

  const raw = fetchGitLog(rootDir, sinceDays)
  if (raw === null) return []

  const commits = parseCommitsFromGitLog(raw, knownFiles, maxFilesPerCommit, maxCommits)
  if (commits.length < 4) return []

  const marginalProb = computeMarginalProb(commits)
  const { condCount, driverCount } = computeLag1Counts(commits)

  return emitGrangerSignals(
    condCount,
    driverCount,
    marginalProb,
    minObservations,
    minExcessX1000,
  )
}

// ─── Phase 1: fetch raw git log ─────────────────────────────────────────────

function fetchGitLog(rootDir: string, sinceDays: number): string | null {
  try {
    return execSync(
      `git log --name-only --pretty=format:'COMMIT' --since=${sinceDays}.days --no-renames`,
      { cwd: rootDir, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 },
    )
  } catch {
    return null
  }
}

// ─── Phase 2: parse raw log into chronological commits ─────────────────────

/**
 * COMMIT lines délimitent. Order brut = chronological reverse (newest first).
 * On reverse en sortie pour avoir t=0 le plus ancien, t=N-1 le plus récent
 * (sliced à `maxCommits` pour garder les plus récents si > limite).
 */
function parseCommitsFromGitLog(
  raw: string,
  knownFiles: Set<string> | undefined,
  maxFilesPerCommit: number,
  maxCommits: number,
): CommitChanges[] {
  const commitsReversed: CommitChanges[] = []
  let current: Set<string> | null = null
  const flush = (): void => {
    if (current && current.size > 0 && current.size <= maxFilesPerCommit) {
      commitsReversed.push({ files: current })
    }
  }
  for (const line of raw.split('\n')) {
    if (line === 'COMMIT') {
      flush()
      current = new Set()
      continue
    }
    if (!current) continue
    const trimmed = line.trim()
    if (!trimmed) continue
    if (knownFiles && !knownFiles.has(trimmed)) continue
    current.add(trimmed)
  }
  flush()
  return commitsReversed.reverse().slice(-maxCommits)
}

// ─── Phase 3: marginal P(file moves at any t) ──────────────────────────────

function computeMarginalProb(commits: CommitChanges[]): Map<string, number> {
  const T = commits.length
  const marginalCount = new Map<string, number>()
  for (const c of commits) {
    for (const f of c.files) {
      marginalCount.set(f, (marginalCount.get(f) ?? 0) + 1)
    }
  }
  const marginalProb = new Map<string, number>()
  for (const [f, n] of marginalCount) {
    marginalProb.set(f, n / T)
  }
  return marginalProb
}

// ─── Phase 4: lag-1 conditional counts ─────────────────────────────────────

interface Lag1Counts {
  /** condCount.get(driver).get(follower) = nb fois (driver at t, follower at t+1). */
  condCount: Map<string, Map<string, number>>
  /** driverCount.get(driver) = nb fois driver at t (avec un t+1 valide). */
  driverCount: Map<string, number>
}

function computeLag1Counts(commits: CommitChanges[]): Lag1Counts {
  const condCount = new Map<string, Map<string, number>>()
  const driverCount = new Map<string, number>()
  for (let t = 0; t < commits.length - 1; t++) {
    const ct = commits[t]
    const ctNext = commits[t + 1]
    for (const driver of ct.files) {
      driverCount.set(driver, (driverCount.get(driver) ?? 0) + 1)
      let inner = condCount.get(driver)
      if (!inner) {
        inner = new Map()
        condCount.set(driver, inner)
      }
      for (const follower of ctNext.files) {
        if (driver === follower) continue
        inner.set(follower, (inner.get(follower) ?? 0) + 1)
      }
    }
  }
  return { condCount, driverCount }
}

// ─── Phase 5: filter + sort + emit signals ─────────────────────────────────

function emitGrangerSignals(
  condCount: Map<string, Map<string, number>>,
  driverCount: Map<string, number>,
  marginalProb: Map<string, number>,
  minObservations: number,
  minExcessX1000: number,
): GrangerCausality[] {
  const out: GrangerCausality[] = []
  for (const [driver, inner] of condCount) {
    const driverN = driverCount.get(driver) ?? 0
    if (driverN === 0) continue
    for (const [follower, observed] of inner) {
      if (observed < minObservations) continue
      const condProb = observed / driverN
      const marginal = marginalProb.get(follower) ?? 0
      const excessX1000 = Math.round((condProb - marginal) * 1000)
      if (excessX1000 < minExcessX1000) continue
      out.push({
        driverFile: driver,
        followerFile: follower,
        observations: observed,
        excessConditionalX1000: excessX1000,
      })
    }
  }
  out.sort(compareGrangerCausality)
  return out
}

function compareGrangerCausality(a: GrangerCausality, b: GrangerCausality): number {
  if (a.excessConditionalX1000 !== b.excessConditionalX1000)
    return b.excessConditionalX1000 - a.excessConditionalX1000
  if (a.driverFile !== b.driverFile) return a.driverFile < b.driverFile ? -1 : 1
  return a.followerFile < b.followerFile ? -1 : 1
}
