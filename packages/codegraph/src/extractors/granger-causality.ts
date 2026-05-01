/**
 * Granger causality — qui drive vraiment qui dans les séquences git.
 *
 * Origine : Clive Granger 1969 (Nobel Economics 2003). Une variable X
 * "Granger-cause" Y si la connaissance des valeurs PASSÉES de X améliore
 * la prédiction des valeurs FUTURES de Y, au-delà de ce que les valeurs
 * passées de Y permettent de prédire seules.
 *
 * Distinction critique vs corrélation :
 *   - Corrélation symétrique : A et B varient ensemble (Jaccard CoChange)
 *   - Causation directionnelle : A change PRÉCÉDE B change (Granger)
 *
 * Application au code : sur les K derniers commits dans l'ordre temporel,
 * pour chaque paire (A, B), regarder la lag-correlation :
 *
 *     P(B change at commit t | A changed at commit t-1) > P(B change at t)
 *
 * Si oui par marge significative = A Granger-cause B. Cela révèle le
 * "driver" architectural : si A bouge, B suit dans le commit suivant.
 *
 * Différenciation vs Bayesian co-change conditional :
 *   - Bayesian P(B|A) : A et B changent dans le MÊME commit (lag 0)
 *   - Granger : A change à t, B change à t+1 (lag 1)
 *
 * Le pattern Granger révèle les vraies dépendances temporelles —
 * "j'ai modifié A, je dois modifier B au prochain commit pour faire
 * passer les tests / refléter la nouvelle interface". Capture les
 * couplages SÉQUENTIELS qui ne se voient pas dans le co-change.
 *
 * Test simplifié : on calcule l'excess conditional probability
 *
 *     excess = P(B at t+1 | A at t) - P(B at t+1)
 *
 * et on émet uniquement si excess > 0.15 (= signal de 15 percentage
 * points au-dessus du baseline). Ratchet bayésien sur fréquence
 * minimale (≥3 occurrences) pour éviter les artefacts statistiques.
 *
 * Discipline : économétrie / time-series analysis (Granger 1969).
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

  let raw: string
  try {
    raw = execSync(
      `git log --name-only --pretty=format:'COMMIT' --since=${sinceDays}.days --no-renames`,
      { cwd: rootDir, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 },
    )
  } catch {
    return []
  }

  // Parser : COMMIT lines délimitent. Order = chronological reverse (newest first).
  // On reverse pour avoir t=0 le plus ancien, t=N-1 le plus récent.
  const commitsReversed: CommitChanges[] = []
  let current: Set<string> | null = null
  for (const line of raw.split('\n')) {
    if (line === 'COMMIT') {
      if (current && current.size > 0 && current.size <= maxFilesPerCommit) {
        commitsReversed.push({ files: current })
      }
      current = new Set()
      continue
    }
    if (!current) continue
    const trimmed = line.trim()
    if (!trimmed) continue
    if (knownFiles && !knownFiles.has(trimmed)) continue
    current.add(trimmed)
  }
  if (current && current.size > 0 && current.size <= maxFilesPerCommit) {
    commitsReversed.push({ files: current })
  }

  if (commitsReversed.length < 4) return []

  // Reverse pour avoir ordre chronologique
  const commits = commitsReversed.reverse().slice(-maxCommits)
  const T = commits.length

  // Marginal P(B at t) pour chaque file
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

  // Conditional count : nb fois où A at t et B at t+1
  // Map<driver, Map<follower, count>>
  const condCount = new Map<string, Map<string, number>>()
  // Driver count : nb fois où A change (peu importe ce qui suit)
  const driverCount = new Map<string, number>()
  for (let t = 0; t < T - 1; t++) {
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

  const out: GrangerCausality[] = []
  for (const [driver, inner] of condCount) {
    const driverN = driverCount.get(driver) ?? 0
    if (driverN === 0) continue
    for (const [follower, observed] of inner) {
      if (observed < minObservations) continue
      // P(follower at t+1 | driver at t)
      const condProb = observed / driverN
      // Marginal P(follower at t)
      const marginal = marginalProb.get(follower) ?? 0
      const excess = condProb - marginal
      const excessX1000 = Math.round(excess * 1000)
      if (excessX1000 < minExcessX1000) continue
      out.push({
        driverFile: driver,
        followerFile: follower,
        observations: observed,
        excessConditionalX1000: excessX1000,
      })
    }
  }

  out.sort((a, b) => {
    if (a.excessConditionalX1000 !== b.excessConditionalX1000)
      return b.excessConditionalX1000 - a.excessConditionalX1000
    if (a.driverFile !== b.driverFile) return a.driverFile < b.driverFile ? -1 : 1
    return a.followerFile < b.followerFile ? -1 : 1
  })

  return out
}
