/**
 * TDA persistence (γ.2c) — Persistent Homology dim-0 sur le call graph runtime.
 *
 * Topological Data Analysis : étudie comment les features topologiques
 * (composantes connexes, boucles, cavités) émergent ou disparaissent
 * lorsqu'on varie un paramètre de filtration.
 *
 * **Pour le call graph runtime, le filtration naturel = edge count desc**.
 * On traite chaque edge runtime comme une "force de lien" (combien de
 * fois A appelle B). En commençant à seuil = max(count), seuls les
 * edges les plus forts sont actifs → beaucoup de composantes isolées.
 * En diminuant le seuil, on active progressivement les edges plus
 * faibles → les composantes fusionnent.
 *
 *   threshold = ∞     : 0 edges  → N components (chaque node isolé)
 *   threshold = max   : 1 edge   → N-1 components
 *   threshold = ...   : ...      : ...
 *   threshold = 0     : all edges → 1 component (tout connecté)
 *
 * Une composante "vit" entre :
 *   - **birth** = threshold quand elle apparaît distincte (haute count)
 *   - **death** = threshold quand elle fusionne dans une autre
 *
 * **persistence = birth - death** mesure la robustesse de la composante.
 *
 * Interprétation :
 *   - Persistence haute = cluster runtime robuste, identifiable même au
 *     filtrage strict. Forme un module fonctionnel cohérent.
 *   - Persistence basse = composante éphémère, fusion immédiate avec le
 *     reste. Pas un vrai cluster — bruit topologique.
 *
 * **Pourquoi en runtime et pas en static** :
 *   - Static call graph : edges présents/absents (binaire).
 *   - Runtime call graph : edges pondérés (fréquence d'invocation).
 *   - La pondération est ce qui rend la persistence informative.
 *
 * **Algorithme — union-find sur edges sorted desc par count** :
 *   Complexité O(E log E + E α(N)) avec α inverse Ackermann ≈ O(1).
 *   Pour ~10k edges, < 10ms.
 *
 * **Limites γ.2c** :
 *   - Dim-0 only (composantes connexes). Dim-1 (loops/cycles topologiques)
 *     demande algorithme persistence pairing — déférer à γ.3.
 *   - Filtration sur file-level call graph (pas symbol-level). File-level
 *     a moins de bruit, signal plus interprétable.
 *
 * Discipline : Algebraic Topology / TDA (Edelsbrunner-Letscher-Zomorodian 2002).
 */

import type { CallEdgeRuntimeFact, RuntimeSnapshot } from '../core/types.js'

export interface PersistentComponentFact {
  /** Rep — file/node "représentatif" de la composante (le plus petit lex). */
  rep: string
  /**
   * Birth threshold = count de l'edge qui a fait naître la composante en
   * tant que cluster distinct. Pour les "infinity" components qui n'ont
   * jamais fusionné (1 par run typiquement), birth = +∞ encodé comme
   * `birthCount = 0` et `deathCount = 0`, persistence = 0.
   */
  birthCount: number
  /**
   * Death threshold = count de l'edge qui a fusionné cette composante
   * dans une autre. 0 pour la composante survivante (jamais morte).
   */
  deathCount: number
  /**
   * Persistence = birth - death. Mesure de la robustesse topologique.
   * Inf component : 0 (convention pour rendre TSV-friendly).
   */
  persistence: number
  /** Taille de la composante au moment de sa mort (nb de nodes mergés). */
  size: number
}

export interface TdaPersistenceOptions {
  /**
   * Min persistence pour qu'une composante soit émise. Default: 1.
   * Filtre les composantes éphémères (birth=N, death=N-1, persistence=1).
   */
  minPersistence?: number
  /**
   * Inclure la composante "survivante" (jamais morte) dans l'output.
   * Default: false. Sa persistence est conventionnellement 0 — peu utile
   * pour les rules.
   */
  includeSurviving?: boolean
}

const DEFAULT_OPTIONS: Required<TdaPersistenceOptions> = {
  minPersistence: 1,
  includeSurviving: false,
}

/**
 * Calcule la dim-0 persistence diagram du call graph runtime au file-level.
 * Pure — déterministe pour un snapshot donné.
 */
export function tdaPersistence(
  snap: RuntimeSnapshot,
  options: TdaPersistenceOptions = {},
): PersistentComponentFact[] {
  const opts = { ...DEFAULT_OPTIONS, ...options }

  const fileEdges = aggregateToFileLevel(snap.callEdges)
  if (fileEdges.length === 0) return []

  const nodes = collectNodes(fileEdges)
  if (nodes.size <= 1) return []

  sortFiltrationEdges(fileEdges)

  const uf = createUnionFind(nodes)
  const deaths: PersistentComponentFact[] = []
  for (const e of fileEdges) {
    processFiltrationEdge(e, uf, opts.minPersistence, deaths)
  }

  if (opts.includeSurviving) emitSurvivors(nodes, uf, deaths)

  deaths.sort(comparePersistence)
  return deaths
}

// ─── Helpers ────────────────────────────────────────────────────────────────

interface FileLevelEdge { from: string; to: string; count: number }

function collectNodes(fileEdges: FileLevelEdge[]): Set<string> {
  const nodes = new Set<string>()
  for (const e of fileEdges) {
    nodes.add(e.from)
    nodes.add(e.to)
  }
  return nodes
}

/** Stable sort : count desc, puis (from, to) pour le déterminisme. */
function sortFiltrationEdges(fileEdges: FileLevelEdge[]): void {
  fileEdges.sort((a, b) =>
    b.count - a.count
      || a.from.localeCompare(b.from)
      || a.to.localeCompare(b.to),
  )
}

/**
 * Union-find with size tracking + birth-count per representative.
 * birthCount[rep] = count of the highest-weight edge incident to rep's
 * component when the component was first formed.
 */
interface UnionFind {
  parent: Map<string, string>
  rank: Map<string, number>
  compSize: Map<string, number>
  compBirthCount: Map<string, number>
  find: (x: string) => string
}

function createUnionFind(nodes: Set<string>): UnionFind {
  const parent = new Map<string, string>()
  const rank = new Map<string, number>()
  const compSize = new Map<string, number>()
  const compBirthCount = new Map<string, number>()
  for (const n of nodes) {
    parent.set(n, n)
    rank.set(n, 0)
    compSize.set(n, 1)
    // Born at "infinity" — singleton with no edge yet, birth is unset.
  }
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)!
    // Path compression
    let cur = x
    while (parent.get(cur) !== r) {
      const next = parent.get(cur)!
      parent.set(cur, r)
      cur = next
    }
    return r
  }
  return { parent, rank, compSize, compBirthCount, find }
}

/**
 * Pour un edge dans l'ordre de filtration, décide le rep mort, émet
 * éventuellement un persistence event, et merge les composants.
 */
function processFiltrationEdge(
  e: FileLevelEdge,
  uf: UnionFind,
  minPersistence: number,
  deaths: PersistentComponentFact[],
): void {
  const ru = uf.find(e.from)
  const rv = uf.find(e.to)
  if (ru === rv) return  // dim-1 loop, γ.3 territory

  const su = uf.compSize.get(ru)!
  const sv = uf.compSize.get(rv)!
  const { dyingRep, survivingRep } = pickDyingAndSurviving(ru, rv, uf.compBirthCount)
  const dyingSize = dyingRep === ru ? su : sv
  const dyingBirth = uf.compBirthCount.get(dyingRep)

  if (dyingBirth !== undefined) {
    const persistence = dyingBirth - e.count
    if (persistence >= minPersistence) {
      deaths.push({
        rep: dyingRep,
        birthCount: dyingBirth,
        deathCount: e.count,
        persistence,
        size: dyingSize,
      })
    }
  }

  mergeComponents(uf, dyingRep, survivingRep, su + sv, e.count)
}

/**
 * Convention de mort, par cas :
 *   1. Both singletons : lex-larger rep dies, no meaningful persistence
 *      (caller voit dyingBirth === undefined → pas d'event émis).
 *   2. One singleton + one cluster : SINGLETON dies, cluster survit
 *      (idem, dyingBirth undefined sur le singleton).
 *   3. Two real clusters : YOUNGER dies (smaller birth = weaker initial
 *      edge). C'est le seul cas qui émet un death event significatif.
 */
function pickDyingAndSurviving(
  ru: string,
  rv: string,
  compBirthCount: Map<string, number>,
): { dyingRep: string; survivingRep: string } {
  const aBirth = compBirthCount.get(ru)
  const bBirth = compBirthCount.get(rv)
  const aIsCluster = aBirth !== undefined
  const bIsCluster = bBirth !== undefined

  if (aIsCluster && bIsCluster) {
    if (aBirth! < bBirth!) return { dyingRep: ru, survivingRep: rv }
    if (aBirth! > bBirth!) return { dyingRep: rv, survivingRep: ru }
    // Tie : lex-larger dies (deterministic)
    return ru < rv ? { dyingRep: rv, survivingRep: ru } : { dyingRep: ru, survivingRep: rv }
  }
  if (aIsCluster) return { dyingRep: rv, survivingRep: ru }
  if (bIsCluster) return { dyingRep: ru, survivingRep: rv }
  // Both singletons — lex-larger dies
  return ru < rv ? { dyingRep: rv, survivingRep: ru } : { dyingRep: ru, survivingRep: rv }
}

/**
 * Union dyingRep INTO survivingRep + maintain size/rank/birth :
 *   - Surviving déjà cluster : garde sa birth.
 *   - Surviving singleton + dying singleton : nouvelle cluster formée à
 *     ce edge → birth = edgeCount.
 *   - Surviving singleton + dying cluster : impossible (singleton meurt
 *     toujours par convention pickDyingAndSurviving).
 */
function mergeComponents(
  uf: UnionFind,
  dyingRep: string,
  survivingRep: string,
  combinedSize: number,
  edgeCount: number,
): void {
  uf.parent.set(dyingRep, survivingRep)
  uf.compSize.set(survivingRep, combinedSize)
  uf.rank.set(
    survivingRep,
    Math.max(uf.rank.get(survivingRep) ?? 0, (uf.rank.get(dyingRep) ?? 0) + 1),
  )
  if (uf.compBirthCount.get(survivingRep) === undefined) {
    uf.compBirthCount.set(survivingRep, edgeCount)
  }
}

/** Emit la composante survivante (jamais morte) en convention persistence=0. */
function emitSurvivors(
  nodes: Set<string>,
  uf: UnionFind,
  deaths: PersistentComponentFact[],
): void {
  const survivors = new Set<string>()
  for (const n of nodes) survivors.add(uf.find(n))
  for (const rep of survivors) {
    deaths.push({
      rep,
      birthCount: uf.compBirthCount.get(rep) ?? 0,
      deathCount: 0,
      persistence: 0,
      size: uf.compSize.get(rep) ?? 1,
    })
  }
}

/** Determinism : persistence desc, then rep asc. */
function comparePersistence(a: PersistentComponentFact, b: PersistentComponentFact): number {
  return b.persistence - a.persistence || a.rep.localeCompare(b.rep)
}

/**
 * Agrège les call edges (fromFile, fromFn) → (toFile, toFn) en edges
 * file-level (fromFile → toFile) avec count sommé. Skip self-edges
 * (fromFile === toFile) — n'apportent rien à la connectivité topologique.
 */
function aggregateToFileLevel(
  callEdges: CallEdgeRuntimeFact[],
): Array<{ from: string; to: string; count: number }> {
  const acc = new Map<string, { from: string; to: string; count: number }>()
  for (const e of callEdges) {
    if (e.fromFile === e.toFile) continue
    // Undirected for connectivity : key by sorted pair.
    const [a, b] = e.fromFile < e.toFile ? [e.fromFile, e.toFile] : [e.toFile, e.fromFile]
    const id = `${a}\x00${b}`
    let cur = acc.get(id)
    if (!cur) {
      cur = { from: a, to: b, count: 0 }
      acc.set(id, cur)
    }
    cur.count += e.count
  }
  return Array.from(acc.values())
}
