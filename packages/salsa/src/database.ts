/**
 * Database — state principal du runtime Salsa.
 *
 * Contient :
 *   - La revision globale (entier monotone)
 *   - Le cache de tous les Cells, organisé par (queryId → encodedKey → Cell)
 *   - Les "input setters" — fonctions externes qui mutent les input queries
 *
 * Une Database est un container — pour tester, créer une instance neuve.
 * Pas de singleton global : chaque module qui crée des queries peut être
 * attaché à une Database différente.
 *
 * Threading : le runtime est mono-thread (Node main loop). Toutes les ops
 * sur Database sont synchrones. AsyncLocalStorage gère la pile de queries
 * en cours d'exécution sans collision.
 */

import {
  REVISION_ZERO,
  type Cell, type EncodedKey, type QueryId, type Revision,
} from './types.js'

export class Database {
  /** Revision courante. Incrémentée par `bumpRevision()`. */
  private revision: Revision = REVISION_ZERO

  /** Storage : queryId → encodedKey → Cell. */
  private cells: Map<QueryId, Map<EncodedKey, Cell>> = new Map()

  /** Registry des query IDs déclarés (input ou derived). Sert pour la
   *  détection de doublon — séparée du cache des cells qui n'est rempli
   *  qu'à la première écriture. */
  private registered: Set<QueryId> = new Set()

  /** Pour chaque derived query : sa fonction de calcul. Permet de la
   *  "réveiller" depuis allDepsStable lors d'un deep-verify. */
  private derivedFns: Map<QueryId, (key: unknown) => unknown> = new Map()

  /** Compteur d'invocations par query, pour les stats / tests. */
  private hitCount: Map<QueryId, number> = new Map()
  private missCount: Map<QueryId, number> = new Map()

  // ─── Revision ─────────────────────────────────────────────────────────

  currentRevision(): Revision {
    return this.revision
  }

  /**
   * Incrémente la revision. Appelé par chaque `set` d'input. Pas exposé en
   * public — c'est le runtime qui décide quand bumper.
   */
  bumpRevision(): Revision {
    this.revision++
    return this.revision
  }

  // ─── Cell access ──────────────────────────────────────────────────────

  getCell(queryId: QueryId, encodedKey: EncodedKey): Cell | undefined {
    return this.cells.get(queryId)?.get(encodedKey)
  }

  setCell(cell: Cell): void {
    let inner = this.cells.get(cell.queryId)
    if (!inner) {
      inner = new Map()
      this.cells.set(cell.queryId, inner)
    }
    inner.set(cell.encodedKey, cell)
  }

  hasQuery(queryId: QueryId): boolean {
    return this.registered.has(queryId)
  }

  /**
   * Marque une query comme déclarée. Appelé par `input()` / `derived()`.
   * Si `fn` est fourni, c'est un derived (on enregistre la fonction pour
   * pouvoir réveiller la query depuis un deep-verify upstream).
   */
  registerQuery(queryId: QueryId, fn?: (key: unknown) => unknown): void {
    this.registered.add(queryId)
    if (fn) this.derivedFns.set(queryId, fn)
  }

  /** Récupère la fonction d'une derived query. undefined si c'est un input. */
  getDerivedFn(queryId: QueryId): ((key: unknown) => unknown) | undefined {
    return this.derivedFns.get(queryId)
  }

  /** Number of cached cells across the whole database. Used by tests. */
  totalCells(): number {
    let n = 0
    for (const m of this.cells.values()) n += m.size
    return n
  }

  // ─── Stats ────────────────────────────────────────────────────────────

  recordHit(queryId: QueryId): void {
    this.hitCount.set(queryId, (this.hitCount.get(queryId) ?? 0) + 1)
  }

  recordMiss(queryId: QueryId): void {
    this.missCount.set(queryId, (this.missCount.get(queryId) ?? 0) + 1)
  }

  /**
   * Snapshot de stats pour le moment. Hit = un appel qui a réutilisé une
   * Cell sans recomputer. Miss = un appel qui a dû exécuter la fonction.
   */
  stats(): {
    revision: Revision
    totalCells: number
    hits: Record<string, number>
    misses: Record<string, number>
  } {
    return {
      revision: this.revision,
      totalCells: this.totalCells(),
      hits: Object.fromEntries(this.hitCount),
      misses: Object.fromEntries(this.missCount),
    }
  }

  /**
   * Reset complet. Utile en tests qui veulent re-créer leurs queries
   * via `input()` / `derived()` après le reset (cf. e2e.test.ts).
   *
   * Pour les use-cases où les queries sont déclarées au top-level d'un
   * module (donc inscrites une seule fois au load) et NE PEUVENT PAS
   * être ré-enregistrées sans throw `duplicateId` — utiliser
   * `resetState()` à la place.
   */
  reset(): void {
    this.revision = REVISION_ZERO
    this.cells.clear()
    this.registered.clear()
    this.derivedFns.clear()
    this.hitCount.clear()
    this.missCount.clear()
  }

  /**
   * Reset l'état observable (cells + revision + stats) en gardant le
   * registry (registered + derivedFns) intact. Utile quand les queries
   * sont déclarées une fois au top-level d'un module et qu'on veut
   * juste vider le cache pour repartir d'une revision propre.
   *
   * Important : sans ça, les wrappers module-level ne peuvent pas se
   * ré-enregistrer (duplicateId throw), mais après un `reset()` plein
   * le runtime perd ses fns derived et ne peut plus wake-up les deps
   * pendant un deep-verify upstream.
   */
  resetState(): void {
    this.revision = REVISION_ZERO
    this.cells.clear()
    this.hitCount.clear()
    this.missCount.clear()
  }
}
