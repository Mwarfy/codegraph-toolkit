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
  SalsaError,
  type Cell, type Dep, type EncodedKey, type QueryId, type Revision,
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

  /**
   * Cells modifiées depuis le dernier `markPersisted()` — set de
   * `${queryId}\x00${encodedKey}` (Sprint 8 — delta saves).
   *
   * Une cell est marquée dirty à chaque `setCell()`. `markPersisted()`
   * clear le set après une sauvegarde réussie. `serializeDirty()`
   * permet d'écrire seulement les cells modifiées.
   */
  private dirtyKeys: Set<string> = new Set()

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
    this.dirtyKeys.add(cell.queryId + '\x00' + cell.encodedKey)
  }

  // drift-ok: encapsulation classique class.method → privateField (registered, derivedFns).
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
  // drift-ok: encapsulation class.method → privateField.
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

  // ─── Persistence (Sprint 7) ──────────────────────────────────────────
  //
  // Sérialise l'état observable (cells + revision) en JSON serializable.
  // Permet de restaurer la DB au démarrage d'un nouveau process pour un
  // cache hit cross-process via CLI.
  //
  // Limites :
  //   - Les `value` des cells doivent être structured-cloneable (Map,
  //     Set, plain objects, primitives, arrays). Pas de fonctions, pas
  //     de classes custom.
  //   - On NE sérialise PAS les fns derived (pas portable). Au load,
  //     les wrappers module-level doivent déjà être enregistrés via
  //     `derived(db, id, fn)` AVANT loadState() — sinon les cells
  //     pointent vers des queryId sans fn enregistrée et le wake-up
  //     échoue silencieusement.
  //   - Les hitCount / missCount NE sont PAS sérialisés (stats
  //     éphémères).

  /**
   * Serialise les cells courants en JSON-safe. Map/Set sont marqués
   * via `__type` pour round-trip via deserializeValue().
   */
  serializeState(): SerializedState {
    const cells: SerializedCell[] = []
    for (const [queryId, inner] of this.cells) {
      for (const [encodedKey, cell] of inner) {
        cells.push({
          queryId,
          encodedKey,
          value: serializeValue(cell.value),
          deps: cell.deps,
          changedAt: cell.changedAt,
          computedAt: cell.computedAt,
          verifiedAt: cell.verifiedAt,
        })
      }
    }
    return {
      version: SERIALIZE_VERSION,
      revision: this.revision,
      cells,
    }
  }

  /**
   * Restaure les cells + revision depuis un état sérialisé. Précondition :
   * tous les `queryId` doivent avoir été enregistrés via `input()` /
   * `derived()` AVANT cet appel — sinon le wake-up échouera.
   *
   * Si la version ne match pas, throw SalsaError 'persistence.version'.
   * Le caller décide d'ignorer (cold start) ou de propager.
   */
  loadState(state: SerializedState): void {
    if (state.version !== SERIALIZE_VERSION) {
      throw new SalsaError(
        'persistence.version',
        `serialized state version ${state.version} != expected ${SERIALIZE_VERSION}`,
      )
    }
    this.cells.clear()
    this.revision = state.revision
    for (const sc of state.cells) {
      const cell: Cell = {
        queryId: sc.queryId,
        encodedKey: sc.encodedKey,
        value: deserializeValue(sc.value),
        deps: sc.deps,
        changedAt: sc.changedAt,
        computedAt: sc.computedAt,
        verifiedAt: sc.verifiedAt,
      }
      this.setCell(cell)
    }
    // Restauration ≠ modification : on est aligné avec le disque.
    this.dirtyKeys.clear()
  }

  // ─── Delta saves (Sprint 8) ─────────────────────────────────────────

  /**
   * Sérialise UNIQUEMENT les cells modifiées depuis le dernier
   * `markPersisted()`. Beaucoup plus rapide que `serializeState()`
   * complet quand peu de fichiers ont changé.
   *
   * Le caller doit ensuite appeler `markPersisted()` pour confirmer
   * que la sauvegarde a réussi (et clear le set dirty).
   */
  serializeDirty(): SerializedDelta {
    const cells: SerializedCell[] = []
    for (const dkey of this.dirtyKeys) {
      const sep = dkey.indexOf('\x00')
      const queryId = dkey.slice(0, sep)
      const encodedKey = dkey.slice(sep + 1)
      const cell = this.getCell(queryId, encodedKey)
      if (!cell) continue
      cells.push({
        queryId, encodedKey,
        value: serializeValue(cell.value),
        deps: cell.deps,
        changedAt: cell.changedAt,
        computedAt: cell.computedAt,
        verifiedAt: cell.verifiedAt,
      })
    }
    return {
      version: SERIALIZE_VERSION,
      revision: this.revision,
      cells,
    }
  }

  /**
   * Applique un delta sérialisé sur l'état courant : merge cells +
   * update revision. Utilisé au load après chargement du baseline.
   */
  applyDelta(delta: SerializedDelta): void {
    if (delta.version !== SERIALIZE_VERSION) {
      throw new SalsaError(
        'persistence.version',
        `delta version ${delta.version} != expected ${SERIALIZE_VERSION}`,
      )
    }
    this.revision = delta.revision  // monotone — la dernière revision écrite gagne
    for (const sc of delta.cells) {
      const cell: Cell = {
        queryId: sc.queryId,
        encodedKey: sc.encodedKey,
        value: deserializeValue(sc.value),
        deps: sc.deps,
        changedAt: sc.changedAt,
        computedAt: sc.computedAt,
        verifiedAt: sc.verifiedAt,
      }
      this.setCell(cell)
    }
    this.dirtyKeys.clear()
  }

  /** Nombre de cells dirty depuis le dernier markPersisted(). */
  dirtyCount(): number {
    return this.dirtyKeys.size
  }

  /** Marque toutes les cells comme persistées (clear dirty). */
  markPersisted(): void {
    this.dirtyKeys.clear()
  }
}

const SERIALIZE_VERSION = 1

export interface SerializedCell {
  queryId: QueryId
  encodedKey: EncodedKey
  value: unknown  // déjà passé par serializeValue
  deps: Dep[]
  changedAt: Revision
  computedAt: Revision
  verifiedAt: Revision
}

export interface SerializedState {
  version: number
  revision: Revision
  cells: SerializedCell[]
}

/**
 * Delta = sous-ensemble de SerializedState qui ne contient que les
 * cells modifiées depuis le dernier markPersisted(). Le format est
 * structurellement identique à SerializedState — au load, on peut
 * appliquer un delta sur un état existant via `applyDelta()`.
 */
export type SerializedDelta = SerializedState

/**
 * Convertit Map/Set en représentation JSON-safe avec marqueur `__type`.
 * Récursif sur les arrays + plain objects.
 */
export function serializeValue(v: unknown): unknown {
  if (v === null || v === undefined) return v
  if (typeof v !== 'object') return v
  if (v instanceof Map) {
    return {
      __type: 'Map',
      entries: [...v.entries()].map(([k, val]) => [serializeValue(k), serializeValue(val)]),
    }
  }
  if (v instanceof Set) {
    return {
      __type: 'Set',
      values: [...v].map(serializeValue),
    }
  }
  if (Array.isArray(v)) return v.map(serializeValue)
  // Plain object
  const out: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = serializeValue(val)
  }
  return out
}

export function deserializeValue(v: unknown): unknown {
  if (v === null || v === undefined) return v
  if (typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(deserializeValue)
  const obj = v as Record<string, unknown>
  if (obj.__type === 'Map') {
    const entries = (obj.entries as [unknown, unknown][]).map(
      ([k, val]) => [deserializeValue(k), deserializeValue(val)] as [unknown, unknown],
    )
    return new Map(entries)
  }
  if (obj.__type === 'Set') {
    const values = (obj.values as unknown[]).map(deserializeValue)
    return new Set(values)
  }
  const out: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(obj)) out[k] = deserializeValue(val)
  return out
}
