/**
 * Monoid algebra — fondation du parallélisme déterministe.
 *
 * Un monoïde est un triplet (S, ⊕, e) où :
 *   - S : ensemble de valeurs
 *   - ⊕ : opération binaire associative — (a ⊕ b) ⊕ c = a ⊕ (b ⊕ c)
 *   - e : élément neutre — a ⊕ e = e ⊕ a = a
 *
 * Si ⊕ est en plus commutative (a ⊕ b = b ⊕ a), on dit "monoïde
 * commutatif" — alors la fusion en parallèle est déterministe peu
 * importe l'ordre d'évaluation (théorème : Church-Rosser confluence
 * sur les rewriting systems clos sous ⊕).
 *
 * Tous les monoïdes définis ici sont commutatifs sauf `appendList` —
 * appendList est associative mais NON commutative (ordre des éléments
 * compte). On la rend "déterministement parallélisable" en triant
 * post-merge sur une clé canonique avant de retourner. C'est l'idiome
 * standard pour collecter des facts par fichier puis les ordonner.
 *
 * Usage typique :
 *
 *   const counts = await parallelMap(files, extractCounts, sumNumberMonoid)
 *   const facts  = await parallelMap(files, extractFacts, appendSortedMonoid(byFile))
 *
 * Cf. CRDT theory (Shapiro 2011), Datalog stratification.
 */

export interface Monoid<T> {
  /** Élément neutre. */
  empty: T
  /** Opération binaire associative + (idéalement) commutative. */
  combine(a: T, b: T): T
  /**
   * Optionnel : sort post-merge pour rendre une opération non-commutative
   * déterministement parallélisable. Si défini, le scheduler appelle
   * sortFn(combine(...)) avant de retourner.
   */
  sortFn?(a: T): T
}

// ─── Monoïdes de base (algèbre commutative) ─────────────────────────────────

/** (ℕ, +, 0) — sum monoïde sur les nombres. Commutatif. */
export const sumNumberMonoid: Monoid<number> = {
  empty: 0,
  combine: (a, b) => a + b,
}

/** (ℕ, max, -∞) — max monoïde. Commutatif. Utile pour p95/maxDepth. */
export const maxNumberMonoid: Monoid<number> = {
  empty: -Infinity,
  combine: (a, b) => Math.max(a, b),
}

/** (Set<T>, ∪, ∅) — union monoïde sur les Sets. Commutatif. */
export function setUnionMonoid<T>(): Monoid<Set<T>> {
  return {
    empty: new Set<T>(),
    combine: (a, b) => {
      // Évite copie inutile si l'un est vide
      if (a.size === 0) return b
      if (b.size === 0) return a
      const out = new Set(a)
      for (const v of b) out.add(v)
      return out
    },
  }
}

/** (Map<K,V>, mergeWith ⊕_V, ∅) — map monoïde paramétré par un monoïde sur les valeurs. */
export function mapMonoid<K, V>(valueMonoid: Monoid<V>): Monoid<Map<K, V>> {
  return {
    empty: new Map<K, V>(),
    combine: (a, b) => {
      if (a.size === 0) return b
      if (b.size === 0) return a
      const out = new Map(a)
      for (const [k, v] of b) {
        const existing = out.get(k)
        out.set(k, existing === undefined ? v : valueMonoid.combine(existing, v))
      }
      return out
    },
  }
}

// ─── Monoïdes "non-commutatif sans perte" ──────────────────────────────────

/**
 * (List<T>, ++, []) avec sort post-merge — append monoïde. Associatif mais
 * non commutatif sur la concat brute. Devient déterministement parallélisable
 * en triant via `keyFn` post-merge.
 *
 * Idiome :
 *   const m = appendSortedMonoid<Fact>(f => `${f.file}:${f.line}`)
 *   parallelMap(files, extract, m)
 *   // → liste triée par (file, line), bit-identique entre runs.
 */
export function appendSortedMonoid<T>(keyFn: (item: T) => string): Monoid<T[]> {
  return {
    empty: [],
    combine: (a, b) => {
      if (a.length === 0) return b
      if (b.length === 0) return a
      // Concat puis sort : le sort en post est nécessaire pour le
      // déterminisme. Cost O((|a|+|b|) log (|a|+|b|)) vs O(|a|+|b|) si
      // commutativif — overhead acceptable, ~5-10% du total typiquement.
      return [...a, ...b]
    },
    sortFn: (a) => [...a].sort((x, y) => keyFn(x).localeCompare(keyFn(y))),
  }
}

/**
 * Fold un array via un monoïde. Implémentation basique mais associative —
 * peut être remplacée par un reduce-tree (log N depth) pour un parallélisme
 * réel via worker_threads en Phase 2.
 */
export function foldMonoid<T>(items: T[], monoid: Monoid<T>): T {
  let acc = monoid.empty
  for (const item of items) {
    acc = monoid.combine(acc, item)
  }
  return monoid.sortFn ? monoid.sortFn(acc) : acc
}
