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

  // 1. Build file-level edges : Map<"a→b", count> aggregating multi-edges.
  const fileEdges = aggregateToFileLevel(snap.callEdges)
  if (fileEdges.length === 0) return []

  // 2. Collect all nodes and sort edges by count desc (filtration order).
  const nodes = new Set<string>()
  for (const e of fileEdges) {
    nodes.add(e.from)
    nodes.add(e.to)
  }
  if (nodes.size <= 1) return []

  // Stable sort : count desc, then (from, to) for determinism.
  fileEdges.sort((a, b) =>
    b.count - a.count
      || a.from.localeCompare(b.from)
      || a.to.localeCompare(b.to),
  )

  // 3. Union-find with size tracking and birth-count per representative.
  // birthCount[rep] = count of the highest-weight edge incident to rep's component
  // when the component was first formed (= when its rep first received an edge).
  const parent = new Map<string, string>()
  const rank = new Map<string, number>()
  const compSize = new Map<string, number>()
  const compBirthCount = new Map<string, number>()
  for (const n of nodes) {
    parent.set(n, n)
    rank.set(n, 0)
    compSize.set(n, 1)
    // Born at "infinity" — for a singleton with no edge yet, birth is unset.
    // We initialize to 0 ; will be overwritten by the first edge.
  }

  function find(x: string): string {
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

  const deaths: PersistentComponentFact[] = []

  for (const e of fileEdges) {
    const ru = find(e.from)
    const rv = find(e.to)
    if (ru === rv) {
      // Same component already — this edge creates a loop (dim-1 feature).
      // γ.2c skip ; γ.3 will track these for cycle persistence.
      continue
    }
    const su = compSize.get(ru)!
    const sv = compSize.get(rv)!

    // Convention de mort, par cas :
    //   1. Both singletons (no compBirthCount) : lex-larger rep dies, no
    //      meaningful persistence (both born at "∞" from filtration POV).
    //      The merge forms a new 2-node cluster ; we don't emit death.
    //   2. One singleton + one cluster : the SINGLETON dies (joins the
    //      cluster). Cluster lives on, no real death event.
    //   3. Two real clusters : the YOUNGER (lower birth count, formed by
    //      weaker initial edge) dies. Persistence = birth - death > 0.
    //      → C'est le seul cas qui produit un death event significatif.
    const aBirth = compBirthCount.get(ru)
    const bBirth = compBirthCount.get(rv)
    const aIsCluster = aBirth !== undefined
    const bIsCluster = bBirth !== undefined

    let dyingRep: string
    let survivingRep: string
    if (aIsCluster && bIsCluster) {
      // Younger dies (= cluster with smaller birth value, formed by weaker edge)
      if (aBirth! < bBirth!) { dyingRep = ru; survivingRep = rv }
      else if (aBirth! > bBirth!) { dyingRep = rv; survivingRep = ru }
      else {
        // Tie : lex-larger dies (deterministic)
        dyingRep = ru < rv ? rv : ru
        survivingRep = dyingRep === ru ? rv : ru
      }
    } else if (aIsCluster) {
      dyingRep = rv; survivingRep = ru
    } else if (bIsCluster) {
      dyingRep = ru; survivingRep = rv
    } else {
      // Both singletons — lex-larger dies, but no real persistence
      dyingRep = ru < rv ? rv : ru
      survivingRep = dyingRep === ru ? rv : ru
    }
    const dyingSize = dyingRep === ru ? su : sv

    const dyingBirth = compBirthCount.get(dyingRep)
    const death = e.count
    if (dyingBirth !== undefined) {
      // Real cluster dying — emit persistence event
      const persistence = dyingBirth - death
      if (persistence >= opts.minPersistence) {
        deaths.push({
          rep: dyingRep,
          birthCount: dyingBirth,
          deathCount: death,
          persistence,
          size: dyingSize,
        })
      }
    }

    // Union dyingRep INTO survivingRep
    parent.set(dyingRep, survivingRep)
    compSize.set(survivingRep, su + sv)
    rank.set(survivingRep, Math.max(rank.get(survivingRep) ?? 0, (rank.get(dyingRep) ?? 0) + 1))

    // Surviving's birth :
    //   - Si surviving était déjà cluster : garde sa birth (l'absorbé est mort)
    //   - Si surviving était singleton + dying singleton (case 1) : nouvelle
    //     cluster formée at this edge → birth = e.count
    //   - Si surviving était singleton + dying cluster (impossible en notre
    //     convention : singleton meurt toujours) — pas de cas.
    if (compBirthCount.get(survivingRep) === undefined) {
      compBirthCount.set(survivingRep, e.count)
    }
  }

  // 4. Optionally emit the surviving component (infinite persistence).
  if (opts.includeSurviving) {
    const survivors = new Set<string>()
    for (const n of nodes) survivors.add(find(n))
    for (const rep of survivors) {
      deaths.push({
        rep,
        birthCount: compBirthCount.get(rep) ?? 0,
        deathCount: 0,
        persistence: 0,
        size: compSize.get(rep) ?? 1,
      })
    }
  }

  // Determinism : sort by persistence desc, then by rep asc.
  deaths.sort((a, b) =>
    b.persistence - a.persistence
      || a.rep.localeCompare(b.rep),
  )

  return deaths
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
