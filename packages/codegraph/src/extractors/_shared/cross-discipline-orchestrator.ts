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
}

/**
 * Run les 11 disciplines en séquence. Mutate `timing.detectors` pour
 * chaque discipline. Retourne `CrossDisciplineResults` agrégé.
 */
export async function runCrossDisciplineDetectors(
  ctx: CrossDisciplineContext,
): Promise<CrossDisciplineResults> {
  const { rootDir, files, sharedProject, snapshot, coChangePairs, timing } = ctx
  const results: CrossDisciplineResults = {}

  // ─── Cross-discipline metrics (Cycle 2bis) ────────────────────────
  // Composent des disciplines mathématiques sous-utilisees dans le code
  // analysis : théorie spectrale (Fiedler), info theory (Shannon),
  // coding theory (Hamming).
  const tSpectral = performance.now()
  try {
    results.spectralMetrics = computeSpectralMetrics(snapshot.nodes, snapshot.edges)
    timing.detectors['spectral-graph'] = performance.now() - tSpectral
  } catch (err) {
    timing.detectors['spectral-graph'] = performance.now() - tSpectral
    console.error(`  ✗ spectral-graph failed: ${err}`)
  }

  const tEntropy = performance.now()
  try {
    if (snapshot.symbolRefs) {
      results.symbolEntropy = computeSymbolEntropy(snapshot.symbolRefs)
    }
    timing.detectors['symbol-entropy'] = performance.now() - tEntropy
  } catch (err) {
    timing.detectors['symbol-entropy'] = performance.now() - tEntropy
    console.error(`  ✗ symbol-entropy failed: ${err}`)
  }

  const tSigDup = performance.now()
  try {
    if (snapshot.typedCalls) {
      results.signatureDuplicates = detectSignatureDuplicates(snapshot.typedCalls.signatures ?? [], {
        hammingThreshold: 0,
        sameKindOnly: true,
        sameNameOnly: true,  // Same exportName = copy-paste avec rename file
      })
    }
    timing.detectors['signature-duplication'] = performance.now() - tSigDup
  } catch (err) {
    timing.detectors['signature-duplication'] = performance.now() - tSigDup
    console.error(`  ✗ signature-duplication failed: ${err}`)
  }

  // ─── Topological Data Analysis (TDA) — persistent homology ─────────
  const tPersistent = performance.now()
  try {
    results.persistentCycles = await computePersistentCycles(rootDir)
    timing.detectors['persistent-cycles'] = performance.now() - tPersistent
  } catch (err) {
    timing.detectors['persistent-cycles'] = performance.now() - tPersistent
    console.error(`  ✗ persistent-cycles failed: ${err}`)
  }

  // ─── Théorie des systèmes dynamiques — Lyapunov exponent approx ────
  const tLyap = performance.now()
  try {
    if (coChangePairs) {
      results.lyapunovMetrics = computeLyapunovMetrics(coChangePairs)
    }
    timing.detectors['lyapunov-cochange'] = performance.now() - tLyap
  } catch (err) {
    timing.detectors['lyapunov-cochange'] = performance.now() - tLyap
    console.error(`  ✗ lyapunov-cochange failed: ${err}`)
  }

  // ─── Théorie des flots — min-cut entre packages (Ford-Fulkerson) ────
  const tMinCut = performance.now()
  try {
    results.packageMinCuts = computePackageMinCuts(snapshot.nodes, snapshot.edges)
    timing.detectors['package-mincut'] = performance.now() - tMinCut
  } catch (err) {
    timing.detectors['package-mincut'] = performance.now() - tMinCut
    console.error(`  ✗ package-mincut failed: ${err}`)
  }

  // ─── Information Bottleneck (Tishby/Pereira/Bialek 1999) ────────────
  const tIB = performance.now()
  try {
    if (snapshot.symbolRefs) {
      results.informationBottlenecks = computeInformationBottleneck(snapshot.symbolRefs)
    }
    timing.detectors['information-bottleneck'] = performance.now() - tIB
  } catch (err) {
    timing.detectors['information-bottleneck'] = performance.now() - tIB
    console.error(`  ✗ information-bottleneck failed: ${err}`)
  }

  // ─── Community detection (Newman-Girvan 2004 / Louvain 2008) ────────
  const tCD = performance.now()
  try {
    const cd = computeCommunityDetection(snapshot.nodes, snapshot.edges)
    results.importCommunities = cd.communities
    results.modularityScore = cd.score
    timing.detectors['community-detection'] = performance.now() - tCD
  } catch (err) {
    timing.detectors['community-detection'] = performance.now() - tCD
    console.error(`  ✗ community-detection failed: ${err}`)
  }

  // ─── Fact stability (Markov stationary distribution) ─────────────────
  const tFS = performance.now()
  try {
    results.factStabilities = await computeFactStability(rootDir)
    timing.detectors['fact-stability'] = performance.now() - tFS
  } catch (err) {
    timing.detectors['fact-stability'] = performance.now() - tFS
    console.error(`  ✗ fact-stability failed: ${err}`)
  }

  // ─── Bayesian co-change conditional P(B|A) — 9e discipline ───────────
  // Calcul direct depuis coChangePairs existant (totalCommitsFrom/To).
  const tBCC = performance.now()
  try {
    if (snapshot.coChangePairs) {
      const out: Array<{ driver: string; follower: string; conditionalProbX1000: number }> = []
      for (const pair of snapshot.coChangePairs) {
        // P(B | A) = count / totalCommitsFrom — A est driver
        if (pair.totalCommitsFrom > 0) {
          const probBA = pair.count / pair.totalCommitsFrom
          if (probBA >= 0.5) {
            out.push({
              driver: pair.from,
              follower: pair.to,
              conditionalProbX1000: Math.round(probBA * 1000),
            })
          }
        }
        // P(A | B) = count / totalCommitsTo — B est driver
        if (pair.totalCommitsTo > 0) {
          const probAB = pair.count / pair.totalCommitsTo
          if (probAB >= 0.5) {
            out.push({
              driver: pair.to,
              follower: pair.from,
              conditionalProbX1000: Math.round(probAB * 1000),
            })
          }
        }
      }
      out.sort((a, b) => {
        if (a.conditionalProbX1000 !== b.conditionalProbX1000) return b.conditionalProbX1000 - a.conditionalProbX1000
        if (a.driver !== b.driver) return a.driver < b.driver ? -1 : 1
        return a.follower < b.follower ? -1 : 1
      })
      results.bayesianCoChanges = out
    }
    timing.detectors['bayesian-cochange'] = performance.now() - tBCC
  } catch (err) {
    timing.detectors['bayesian-cochange'] = performance.now() - tBCC
    console.error(`  ✗ bayesian-cochange failed: ${err}`)
  }

  // ─── NCD Kolmogorov compression similarity — 10e discipline ──────────
  const tNCD = performance.now()
  try {
    results.compressionDistances = await analyzeCompressionSimilarity(rootDir, files, sharedProject)
    timing.detectors['compression-similarity'] = performance.now() - tNCD
  } catch (err) {
    timing.detectors['compression-similarity'] = performance.now() - tNCD
    console.error(`  ✗ compression-similarity failed: ${err}`)
  }

  // ─── Granger causality sur séquences git — 11e discipline ────────────
  const tGr = performance.now()
  try {
    const knownFiles = new Set(snapshot.nodes.map((n) => n.id))
    results.grangerCausalities = await computeGrangerCausality(rootDir, { knownFiles })
    timing.detectors['granger-causality'] = performance.now() - tGr
  } catch (err) {
    timing.detectors['granger-causality'] = performance.now() - tGr
    console.error(`  ✗ granger-causality failed: ${err}`)
  }

  return results
}
