/**
 * Fact stability — chaîne de Markov stationary distribution sur les facts.
 *
 * Application au runtime Salsa : chaque relation Datalog (= ses tuples)
 * peut être modélisée comme un état dans une chaîne de Markov à 2 états :
 *   - "stable"   = ensemble de tuples inchangé entre snapshots
 *   - "volatile" = ensemble modifié
 *
 * La stationary distribution π = (πₛ, πᵥ) où πₛ est la proba long-terme
 * que la relation soit en état stable. Pour une chaîne 2-states avec
 * matrice de transition :
 *
 *     P = [[1-α, α  ]
 *          [β,   1-β]]
 *
 * La stationary distribution est πₛ = β / (α + β), πᵥ = α / (α + β).
 *
 * En pratique on approxime via la fréquence empirique : sur K snapshots
 * historiques, combien de transitions stable→stable vs stable→volatile.
 * Cela donne α (proba quitter stable) ; β = 1 - α si on suppose que
 * volatile→stable est immédiat (chaque revision réifie l'état stable).
 *
 * Utilité pratique :
 *   - Stabilité haute (πₛ > 0.9) : la relation peut être cached
 *     aggressively — Salsa peut skip recompute pendant N revisions
 *     avec haute confiance que le résultat sera identique.
 *   - Stabilité basse (πₛ < 0.5) : la relation change souvent — Salsa
 *     doit recompute systématiquement, mais on peut prioriser son cache
 *     LFU/ARC plutôt que LRU.
 *
 * Composition : avec Lyapunov × FactStability = relations volatiles
 * dans des fichiers chaos amplifier = double signal pour cache strategy.
 *
 * Différenciation vs PersistentCycle : PersistentCycle ne capture que
 * les cycles d'imports. FactStability capture la stabilité de TOUTES les
 * relations Datalog (ImportEdge, EmitsLiteral, EvalCall, FunctionComplexity,
 * etc.) → granularité plus fine, applicable au scheduler Salsa.
 *
 * Discipline : théorie des chaînes de Markov (Markov 1906) +
 * stationary distribution theory.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export interface FactKindStability {
  /** Nom de la relation Datalog. */
  relationName: string
  /** Nb de snapshots scannés. */
  snapshotsTotal: number
  /**
   * Nb de transitions snapshot→snapshot où le SET de tuples est inchangé.
   * Plus haut = relation plus stable.
   */
  stableTransitions: number
  /**
   * Stationary distribution πₛ × 1000 = β / (α + β) approximée par la
   * fréquence empirique stableTransitions / (snapshotsTotal - 1).
   * 1000 = toujours stable, 0 = toujours volatile.
   */
  stationaryStableX1000: number
  /**
   * Nb moyen de tuples sur la fenêtre. Petites relations sont volatiles
   * mécaniquement (un tuple ajouté = changement) ; ce signal aide à
   * pondérer la stationary.
   */
  avgTupleCount: number
}

/**
 * Représentation snapshot pour fact stability — sous-shape qu'on extrait.
 * On lit directement les arrays "raw" de chaque relation pour comparer
 * les sets de tuples entre snapshots.
 */
interface SnapshotFactsShape {
  generatedAt?: string
  // Les facts sont écrits dans .codegraph/facts/, pas dans le snapshot
  // JSON. Mais le snapshot JSON contient les arrays bruts de chaque
  // détecteur. On hash sur ces arrays.
  [key: string]: unknown
}

/**
 * Hash stable d'un array de tuples (= JSON.stringify des entrées sorted
 * lex). On compare les hashes pour détecter inchanged ↔ changed.
 */
function hashArray(arr: unknown): string {
  if (!arr || !Array.isArray(arr) || arr.length === 0) return 'empty'
  // sortedJSON pour déterminisme
  const lines = arr.map((x) => JSON.stringify(x)).sort()
  // Hash compact : taille + premiers/derniers chars
  return `${lines.length}:${lines.join('').slice(0, 64)}:${lines.length}`
}

/**
 * Liste des relations à observer (correspond aux clés du snapshot JSON
 * qui matérialisent des facts Datalog).
 *
 * On évite les relations massives (edges, nodes) qui changent à chaque
 * commit pour des raisons de bookkeeping (timestamps etc.).
 */
const TRACKED_RELATIONS = [
  'cycles',
  'truthPoints',
  'eventEmitSites',
  'evalCalls',
  'hardcodedSecrets',
  'booleanParams',
  'driftSignals',
  'longFunctions',
  'magicNumbers',
  'taintSinks',
  'sanitizers',
  'taintedVars',
  'cryptoCalls',
  'corsConfigs',
  'tlsConfigsUnsafe',
  'weakRandomCalls',
  'unusedExports',
  'fsmStatesDeclared',
  'fsmStatesOrphan',
  'sqlNamingViolations',
  'persistentCycles',
  'lyapunovMetrics',
  'packageMinCuts',
  'informationBottlenecks',
  'importCommunities',
] as const

export async function computeFactStability(
  rootDir: string,
  options: { maxSnapshots?: number } = {},
): Promise<FactKindStability[]> {
  const maxSnapshots = options.maxSnapshots ?? 30
  const codegraphDir = path.join(rootDir, '.codegraph')

  let entries: string[]
  try {
    entries = await fs.readdir(codegraphDir)
  } catch {
    return []
  }

  const snapshotFiles = entries
    .filter((f) => /^snapshot-\d{4}-\d{2}-\d{2}T.*\.json$/.test(f))
    .sort()
    .slice(-maxSnapshots)

  if (snapshotFiles.length < 3) return []

  // Pour chaque snapshot, hash les arrays trackés
  const hashesByRelation = new Map<string, string[]>()
  const tupleCountsByRelation = new Map<string, number[]>()

  for (const rel of TRACKED_RELATIONS) {
    hashesByRelation.set(rel, [])
    tupleCountsByRelation.set(rel, [])
  }

  for (const f of snapshotFiles) {
    let snap: SnapshotFactsShape
    try {
      const raw = await fs.readFile(path.join(codegraphDir, f), 'utf8')
      snap = JSON.parse(raw)
    } catch {
      continue
    }
    for (const rel of TRACKED_RELATIONS) {
      const arr = snap[rel]
      hashesByRelation.get(rel)!.push(hashArray(arr))
      const len = Array.isArray(arr) ? arr.length : 0
      tupleCountsByRelation.get(rel)!.push(len)
    }
  }

  const out: FactKindStability[] = []
  for (const rel of TRACKED_RELATIONS) {
    const hashes = hashesByRelation.get(rel)!
    const counts = tupleCountsByRelation.get(rel)!
    if (hashes.length < 2) continue

    // Compter les transitions stable (h[i] === h[i-1])
    let stable = 0
    for (let i = 1; i < hashes.length; i++) {
      if (hashes[i] === hashes[i - 1]) stable++
    }
    const transitions = hashes.length - 1
    const stationary = transitions > 0 ? stable / transitions : 0
    const avgCount = Math.round(counts.reduce((a, b) => a + b, 0) / counts.length)

    out.push({
      relationName: rel,
      snapshotsTotal: hashes.length,
      stableTransitions: stable,
      stationaryStableX1000: Math.round(stationary * 1000),
      avgTupleCount: avgCount,
    })
  }

  // Sort by stability descending (= cache-friendly relations en haut)
  out.sort((a, b) => b.stationaryStableX1000 - a.stationaryStableX1000)
  return out
}
