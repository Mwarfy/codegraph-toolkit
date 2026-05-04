/**
 * Submodular test selection — quels tests ajouter en priorité ?
 *
 * Discipline : optimisation submodulaire (Nemhauser-Wolsey-Fisher 1978).
 * Une fonction f: 2^V → R est submodulaire si f(S ∪ {e}) - f(S) ≥
 * f(T ∪ {e}) - f(T) pour S ⊆ T (gain marginal décroissant). Pour ce
 * type de fonction, l'algo glouton donne (1 - 1/e) ≈ 0.63 d'optimal —
 * borne fameuse, atteinte dans des problèmes de couverture.
 *
 * Application code coverage : pour un set S de fichiers testés,
 *   f(S) = nombre de fichiers atteints par les tests dans S
 * (computé via les imports + co-changes — un test sur file F couvre F
 * et indirectement tous ses imports proches).
 *
 * f est submodulaire (chaque test ajouté couvre moins en moyenne car
 * les couverts précédemment se chevauchent). Donc le greedy donne une
 * bonne approximation de "quels K fichiers tester en priorité pour
 * maximiser la marginal coverage".
 *
 * Pondération par hits runtime : un fichier hot non testé apporte plus
 * de couverture *utile* qu'un fichier froid. On utilise SymbolTouchedRuntime
 * count comme weight.
 *
 * Coût : O(K × N²) naive (K iterations × N candidates × N coverage check),
 * acceptable pour N < 500.
 */

export interface CoverageEdge {
  from: string  // file qui peut couvrir
  to: string    // file couvert (typiquement: import target)
}

export interface FileWeight {
  file: string
  weight: number  // runtime hits, complexity score, etc.
}

export interface SubmodularOptions {
  /** Edges "couvre". from F →to G : tester F couvre indirectement G. */
  coverageEdges: CoverageEdge[]
  /** Files déjà testés (S₀ initial). */
  alreadyTested: string[]
  /** Weights par file (importance). Default uniform 1. */
  weights?: FileWeight[]
  /** Combien de tests à ajouter (k dans le greedy). Default 5. */
  budget?: number
}

export interface TestRecommendation {
  file: string
  /** Marginal coverage gain (somme des weights des fichiers nouvellement couverts). */
  marginalGain: number
  /** Liste des fichiers nouvellement couverts en ajoutant ce test. */
  newlyCovered: string[]
}

/**
 * Greedy submodular selection. À chaque étape, ajoute le test qui
 * apporte le max de marginal coverage. Stoppe au budget atteint ou
 * quand aucun test n'apporte de gain (saturation).
 */
export function selectTestsGreedy(opts: SubmodularOptions): TestRecommendation[] {
  const budget = opts.budget ?? 5
  const weightOf = buildWeightFn(opts.weights ?? [])
  const coverageOf = buildCoverageMap(opts.coverageEdges)
  const candidates = buildCandidateSet(coverageOf, opts.alreadyTested)
  const covered = buildInitialCovered(coverageOf, opts.alreadyTested)

  const recs: TestRecommendation[] = []
  for (let k = 0; k < budget; k++) {
    const best = findBestCandidate(candidates, coverageOf, covered, weightOf)
    if (!best) break
    recs.push(best.recommendation)
    candidates.delete(best.recommendation.file)
    for (const f of best.recommendation.newlyCovered) covered.add(f)
  }
  return recs
}

function buildWeightFn(weights: FileWeight[]): (f: string) => number {
  const map = new Map<string, number>()
  for (const w of weights) map.set(w.file, w.weight)
  return (f) => map.get(f) ?? 1
}

function buildCoverageMap(edges: CoverageEdge[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const e of edges) {
    let s = out.get(e.from)
    if (!s) {
      s = new Set<string>()
      out.set(e.from, s)
    }
    s.add(e.from)  // F couvre F lui-même
    s.add(e.to)
  }
  return out
}

function buildCandidateSet(
  coverageOf: Map<string, Set<string>>,
  alreadyTested: string[],
): Set<string> {
  const candidates = new Set<string>(coverageOf.keys())
  for (const t of alreadyTested) candidates.delete(t)
  return candidates
}

function buildInitialCovered(
  coverageOf: Map<string, Set<string>>,
  alreadyTested: string[],
): Set<string> {
  const covered = new Set<string>()
  for (const t of alreadyTested) {
    const c = coverageOf.get(t)
    if (c) for (const f of c) covered.add(f)
  }
  return covered
}

function findBestCandidate(
  candidates: Set<string>,
  coverageOf: Map<string, Set<string>>,
  covered: Set<string>,
  weightOf: (f: string) => number,
): { recommendation: TestRecommendation } | null {
  let bestFile: string | null = null
  let bestGain = 0
  let bestNew: string[] = []
  for (const cand of candidates) {
    const evaluated = evaluateCandidate(cand, coverageOf, covered, weightOf)
    if (evaluated.gain > bestGain) {
      bestGain = evaluated.gain
      bestFile = cand
      bestNew = evaluated.newlyCovered
    }
  }
  if (!bestFile || bestGain === 0) return null
  return {
    recommendation: { file: bestFile, marginalGain: bestGain, newlyCovered: bestNew.sort() },
  }
}

function evaluateCandidate(
  cand: string,
  coverageOf: Map<string, Set<string>>,
  covered: Set<string>,
  weightOf: (f: string) => number,
): { gain: number; newlyCovered: string[] } {
  const c = coverageOf.get(cand)
  if (!c) return { gain: 0, newlyCovered: [] }
  const newlyCovered: string[] = []
  let gain = 0
  for (const f of c) {
    if (!covered.has(f)) {
      newlyCovered.push(f)
      gain += weightOf(f)
    }
  }
  return { gain, newlyCovered }
}

export function renderSubmodularMarkdown(recs: TestRecommendation[]): string {
  if (recs.length === 0) return ''
  const lines: string[] = []
  lines.push('## 🧪 Test priorities (submodular greedy, ~0.63 optimal)')
  lines.push('')
  lines.push('Tests à ajouter pour max marginal coverage :')
  lines.push('')
  for (const r of recs) {
    lines.push(`- \`${r.file}\` — gain ${r.marginalGain.toFixed(0)} (couvre ${r.newlyCovered.length} nouveaux fichiers)`)
  }
  return lines.join('\n')
}
