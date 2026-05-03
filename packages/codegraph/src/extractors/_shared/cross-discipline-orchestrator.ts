/**
 * Cross-discipline orchestrator — extrait depuis analyzer.ts pour
 * réduire la cognitive load du god-file (META-COMPOSITE-CRITICAL-INSTABILITY
 * détecté).
 *
 * Wrappe les 11 disciplines mathématiques en un seul appel orchestré :
 *   - Théorie spectrale (Fiedler λ₂)
 *   - Théorie de l'information (Shannon entropy)
 *   - Théorie des codes (Hamming signature)
 *   - TDA (persistent homology cycles)
 *   - Systèmes dynamiques (Lyapunov exponent)
 *   - Théorie des flots (Ford-Fulkerson min-cut packages)
 *   - Information bottleneck (Tishby)
 *   - Community detection (Newman-Girvan / Louvain)
 *   - Markov stationary (fact stability)
 *   - Bayesian conditional P(B|A) (co-change directionnel)
 *   - NCD Kolmogorov (compression similarity)
 *   - Granger causality (lag-1 git séquences)
 *
 * Chaque bloc garde son try/catch + timing tracking — comportement
 * byte-identique au inline précédent. Pas de pattern Detector classes
 * (gardé fonctionnel pour minimiser le risque de parité).
 */

import type { Project } from 'ts-morph'
import type { GraphSnapshot } from '../../core/types.js'
import type { CoChangePair } from '../co-change.js'

import { computeSpectralMetrics, type SpectralMetric } from '../spectral-graph.js'
import { computeSymbolEntropy, type SymbolEntropyMetric } from '../symbol-entropy.js'
import { detectSignatureDuplicates, type SignatureDuplicate } from '../signature-duplication.js'
import { computePersistentCycles, type PersistentCycle } from '../persistent-cycles.js'
import { computeLyapunovMetrics, type LyapunovMetric } from '../lyapunov-cochange.js'
import { computePackageMinCuts, type PackageMinCut } from '../package-mincut.js'
import { computeInformationBottleneck, type InformationBottleneck } from '../information-bottleneck.js'
import { computeCommunityDetection, type ImportCommunity, type ModularityScore } from '../community-detection.js'
import { computeFactStability, type FactKindStability } from '../fact-stability.js'
import { analyzeCompressionSimilarity, type NormalizedCompressionDistance } from '../compression-similarity.js'
import { allCompressionSimilarity as incAllCompressionSimilarity } from '../../incremental/compression-similarity.js'
import { computeGrangerCausality, type GrangerCausality } from '../granger-causality.js'

export interface CrossDisciplineResults {
  spectralMetrics?: SpectralMetric[]
  symbolEntropy?: SymbolEntropyMetric[]
  signatureDuplicates?: SignatureDuplicate[]
  persistentCycles?: PersistentCycle[]
  lyapunovMetrics?: LyapunovMetric[]
  packageMinCuts?: PackageMinCut[]
  informationBottlenecks?: InformationBottleneck[]
  importCommunities?: ImportCommunity[]
  modularityScore?: ModularityScore
  factStabilities?: FactKindStability[]
  bayesianCoChanges?: Array<{ driver: string; follower: string; conditionalProbX1000: number }>
  compressionDistances?: NormalizedCompressionDistance[]
  grangerCausalities?: GrangerCausality[]
}

export interface CrossDisciplineContext {
  rootDir: string
  files: string[]
  sharedProject: Project
  snapshot: GraphSnapshot
  coChangePairs: CoChangePair[] | undefined
  timing: { detectors: Record<string, number> }
  /** Si true, utilise les Salsa wrappers pour les détecteurs Salsa-isés. */
  incremental?: boolean
}

/**
 * Run les 11 disciplines en séquence. Mutate `timing.detectors` pour
 * chaque discipline. Retourne `CrossDisciplineResults` agrégé.
 */
export async function runCrossDisciplineDetectors(
  ctx: CrossDisciplineContext,
): Promise<CrossDisciplineResults> {
  const { rootDir, files, sharedProject, snapshot, coChangePairs, timing } = ctx
  const incremental = ctx.incremental ?? false
  const results: CrossDisciplineResults = {}

  // Cross-discipline metrics (Cycle 2bis) — théorie spectrale (Fiedler),
  // info theory (Shannon), coding theory (Hamming).
  await runDetector(timing, 'spectral-graph', () => {
    results.spectralMetrics = computeSpectralMetrics(snapshot.nodes, snapshot.edges)
  })
  await runDetector(timing, 'symbol-entropy', () => {
    if (snapshot.symbolRefs) results.symbolEntropy = computeSymbolEntropy(snapshot.symbolRefs)
  })
  await runDetector(timing, 'signature-duplication', () => {
    if (snapshot.typedCalls) {
      results.signatureDuplicates = detectSignatureDuplicates(snapshot.typedCalls.signatures ?? [], {
        hammingThreshold: 0,
        sameKindOnly: true,
        sameNameOnly: true,  // Same exportName = copy-paste avec rename file
      })
    }
  })

  // Topological Data Analysis (TDA) — persistent homology.
  await runDetector(timing, 'persistent-cycles', async () => {
    results.persistentCycles = await computePersistentCycles(rootDir)
  })

  // Théorie des systèmes dynamiques — Lyapunov exponent approx.
  await runDetector(timing, 'lyapunov-cochange', () => {
    if (coChangePairs) results.lyapunovMetrics = computeLyapunovMetrics(coChangePairs)
  })

  // Théorie des flots — min-cut entre packages (Ford-Fulkerson).
  await runDetector(timing, 'package-mincut', () => {
    results.packageMinCuts = computePackageMinCuts(snapshot.nodes, snapshot.edges)
  })

  // Information Bottleneck (Tishby/Pereira/Bialek 1999).
  await runDetector(timing, 'information-bottleneck', () => {
    if (snapshot.symbolRefs) {
      results.informationBottlenecks = computeInformationBottleneck(snapshot.symbolRefs)
    }
  })

  // Community detection (Newman-Girvan 2004 / Louvain 2008).
  await runDetector(timing, 'community-detection', () => {
    const cd = computeCommunityDetection(snapshot.nodes, snapshot.edges)
    results.importCommunities = cd.communities
    results.modularityScore = cd.score
  })

  // Fact stability (Markov stationary distribution).
  await runDetector(timing, 'fact-stability', async () => {
    results.factStabilities = await computeFactStability(rootDir)
  })

  // Bayesian co-change conditional P(B|A) — 9e discipline.
  await runDetector(timing, 'bayesian-cochange', () => {
    if (snapshot.coChangePairs) {
      results.bayesianCoChanges = computeBayesianCoChanges(snapshot.coChangePairs)
    }
  })

  // NCD Kolmogorov compression similarity — 10e discipline. Salsa-iso :
  // per-file snippets cached on fileContent (NCD pairwise reste hors-cache
  // car cross-file). Cold path identique au legacy.
  await runDetector(timing, 'compression-similarity', async () => {
    results.compressionDistances = incremental
      ? incAllCompressionSimilarity.get('all')
      : await analyzeCompressionSimilarity(rootDir, files, sharedProject)
  })

  // Granger causality sur séquences git — 11e discipline.
  await runDetector(timing, 'granger-causality', async () => {
    const knownFiles = new Set(snapshot.nodes.map((n) => n.id))
    results.grangerCausalities = await computeGrangerCausality(rootDir, { knownFiles })
  })

  return results
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Runner unique pour chaque discipline : timing + try/catch + log unifiés.
 * `fn` peut être sync ou async — `await` bénin sur retour sync.
 *
 * Mutation : timing.detectors[name] est toujours set (succès ou erreur).
 */
async function runDetector(
  timing: { detectors: Record<string, number> },
  name: string,
  fn: () => void | Promise<void>,
): Promise<void> {
  const t = performance.now()
  try {
    await fn()
  } catch (err) {
    console.error(`  ✗ ${name} failed: ${err}`)
  } finally {
    timing.detectors[name] = performance.now() - t
  }
}

interface BayesianCoChangeRow {
  driver: string
  follower: string
  conditionalProbX1000: number
}

/**
 * Bayesian conditional P(B|A) depuis les coChangePairs — chaque pair
 * produit jusqu'à 2 directions (A→B et B→A), filtrées par seuil 0.5.
 * Sort : prob desc, driver asc, follower asc.
 */
function computeBayesianCoChanges(
  pairs: ReadonlyArray<CoChangePair>,
): BayesianCoChangeRow[] {
  const out: BayesianCoChangeRow[] = []
  for (const pair of pairs) {
    pushIfAbove(out, pair.from, pair.to, pair.count, pair.totalCommitsFrom)
    pushIfAbove(out, pair.to, pair.from, pair.count, pair.totalCommitsTo)
  }
  out.sort(compareBayesianRow)
  return out
}

function pushIfAbove(
  out: BayesianCoChangeRow[],
  driver: string,
  follower: string,
  count: number,
  total: number,
): void {
  if (total <= 0) return
  const prob = count / total
  if (prob < 0.5) return
  out.push({ driver, follower, conditionalProbX1000: Math.round(prob * 1000) })
}

function compareBayesianRow(a: BayesianCoChangeRow, b: BayesianCoChangeRow): number {
  if (a.conditionalProbX1000 !== b.conditionalProbX1000) {
    return b.conditionalProbX1000 - a.conditionalProbX1000
  }
  if (a.driver !== b.driver) return a.driver < b.driver ? -1 : 1
  return a.follower < b.follower ? -1 : 1
}
