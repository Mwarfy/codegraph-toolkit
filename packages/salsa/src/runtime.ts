/**
 * Runtime Salsa — capture des dépendances, validation des cells, recompute.
 *
 * Le pattern central : pendant qu'une query Q s'exécute, on track tous les
 * autres appels de query qu'elle fait. Ces appels deviennent les "deps" de
 * Q. Au prochain run, on regarde si l'un de ses deps a changé : si oui, Q
 * doit être recomputé ; sinon, on retourne sa valeur cachée.
 *
 * Outil : AsyncLocalStorage permet d'accéder au "current execution context"
 * depuis une callee de manière transparente. Pas besoin de passer un
 * paramètre `ctx` partout — ça ressemble à du code normal du point de vue
 * de l'auteur de la query.
 *
 * Décision sync vs async : le runtime est sync. Les queries doivent être
 * synchrones aussi (pas de Promise renvoyée). C'est volontaire :
 *   - Les opérations cibles (parse AST, scan AST, agrégation) sont sync
 *     côté ts-morph et JS standard.
 *   - Sync = pas de races, pas de "halfway invalidation" pendant un await.
 *   - I/O (lire un fichier) doit être un input set explicite, pas un side-
 *     effect dans une derived query.
 *
 * Si vraiment besoin d'async un jour : wrap avec un cache externe par-dessus.
 * Pour les use-cases codegraph (parse AST sync via ts-morph), pas pertinent.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { Database } from './database.js'
import { encodeKey } from './key-encoder.js'
import {
  REVISION_ZERO, SalsaError,
  type Cell, type Dep, type EncodedKey,
  type QueryId, type QueryKey, type Revision,
} from './types.js'

// ─── Execution context ──────────────────────────────────────────────────────

/**
 * Frame d'exécution courante : la query en cours collecte ses deps ici.
 * `inFlight` est l'ensemble (queryId, encodedKey) des queries dans la pile
 * — utilisé pour détecter les cycles.
 */
interface Frame {
  queryId: QueryId
  encodedKey: EncodedKey
  deps: Dep[]
  /** Set partagée par toutes les frames de la pile actuelle. */
  inFlight: Set<string>
}

const als = new AsyncLocalStorage<Frame>()

// ─── Query types ────────────────────────────────────────────────────────────

/**
 * Une derived query. Génère sa valeur via une fonction pure des inputs.
 *
 * Le type est paramétré sur K (key) et V (value) pour donner une API typée.
 *
 * Constructed via `database.derived(...)`.
 */
export interface DerivedQuery<K extends QueryKey, V> {
  readonly id: QueryId
  /** Synchronously fetch the value for `key`, recomputing if needed. */
  get(key: K): V
  /** Inspect the cached cell for debugging. */
  peek(key: K): Cell | undefined
}

/**
 * Une input query. Sa valeur est SET de l'extérieur. Pas de fonction de calcul.
 *
 * `set(key, value)` est la seule façon de la muter. Chaque set bump la
 * revision globale et marque le Cell comme `changedAt = newRevision`.
 *
 * Lire une input avant qu'elle ait été set throws — pas de "default value"
 * implicite, c'est une erreur qui mérite d'être visible.
 */
export interface InputQuery<K extends QueryKey, V> {
  readonly id: QueryId
  get(key: K): V
  set(key: K, value: V): void
  /** Test : a-t-on déjà set cette key ? */
  has(key: K): boolean
}

// ─── Constructors ───────────────────────────────────────────────────────────

/**
 * Definir une input query. Sa fonction de calcul est implicite (lit le Cell
 * déjà set, throw sinon).
 *
 * @param db   Database à attacher
 * @param id   Nom unique. Doit être unique dans toute la base.
 */
export function input<K extends QueryKey, V>(
  db: Database, id: QueryId,
): InputQuery<K, V> {
  if (db.hasQuery(id)) {
    throw new SalsaError('query.duplicateId',
      `query id '${id}' is already registered on this database`)
  }
  db.registerQuery(id)
  return {
    id,
    get(key: K): V {
      const ek = encodeKey(key)
      // Track dependency if we are in a frame.
      const cell = db.getCell(id, ek)
      if (!cell) {
        throw new SalsaError('input.unset',
          `input '${id}' has no value for key ${JSON.stringify(key)} — call .set first`)
      }
      const frame = als.getStore()
      if (frame) {
        frame.deps.push({ queryId: id, encodedKey: ek, seenAt: cell.changedAt })
      }
      return cell.value as V
    },
    set(key: K, value: V): void {
      if (als.getStore()) {
        throw new SalsaError('input.setInsideQuery',
          `cannot .set input '${id}' from inside a derived query — inputs are external`)
      }
      const ek = encodeKey(key)
      const newRev = db.bumpRevision()
      const existing = db.getCell(id, ek)
      // Si la nouvelle valeur est strictement égale, on ne BUMP PAS changedAt
      // — c'est l'optimisation "no-op write" (cf. Salsa). Mais on bump quand
      // même la revision pour l'horloge globale.
      const valueIsSame = existing !== undefined &&
        Object.is(existing.value, value)
      const cell: Cell = {
        queryId: id,
        encodedKey: ek,
        value,
        deps: [],
        changedAt: valueIsSame ? existing.changedAt : newRev,
        computedAt: newRev,
        verifiedAt: newRev,
      }
      db.setCell(cell)
    },
    has(key: K): boolean {
      return db.getCell(id, encodeKey(key)) !== undefined
    },
  }
}

/**
 * Definir une derived query. Sa valeur est calculée par `fn(key)` qui peut
 * appeler d'autres queries (.get) — celles-ci deviennent automatiquement
 * les deps du résultat.
 *
 * @param db   Database à attacher
 * @param id   Nom unique
 * @param fn   Fonction PURE de calcul. Synchrone.
 */
export function derived<K extends QueryKey, V>(
  db: Database, id: QueryId,
  fn: (key: K) => V,
): DerivedQuery<K, V> {
  if (db.hasQuery(id)) {
    throw new SalsaError('query.duplicateId',
      `query id '${id}' is already registered on this database`)
  }
  // Type-erase pour stockage : permet à allDepsStable de réveiller cette
  // query depuis n'importe où dans le graphe.
  db.registerQuery(id, fn as (key: unknown) => unknown)
  return {
    id,
    get(key: K): V {
      const ek = encodeKey(key)
      return runDerived(db, id, ek, key, fn)
    },
    peek(key: K): Cell | undefined {
      return db.getCell(id, encodeKey(key))
    },
  }
}

// ─── Core algorithm ─────────────────────────────────────────────────────────

/**
 * Execute / re-validate / re-fetch a derived query.
 *
 * Algorithme :
 *   1. Cell absent     → exécuter (miss)
 *   2. Cell verifiedAt = currentRevision → cached (hit, fast path)
 *   3. Sinon, vérifier chaque dep :
 *        - rappeler récursivement la dep pour la mettre à jour si besoin
 *        - si une dep a changé après notre `computedAt` → recompute
 *      Si tous les deps sont stables → marquer verifiedAt = currentRevision,
 *      retourner cached (hit, slow path).
 *
 * Capture des deps :
 *   - Push une frame dans AsyncLocalStorage
 *   - Exécuter fn(key)
 *   - Lire les deps accumulées dans la frame
 *   - Pop la frame
 *
 * Cycle detection : avant de push une frame, on check `inFlight` — si la
 * paire (queryId, encodedKey) y est déjà, c'est un cycle.
 */
function runDerived<K, V>(
  db: Database,
  queryId: QueryId,
  encodedKey: EncodedKey,
  key: K,
  fn: (key: K) => V,
): V {
  const cur = db.currentRevision()
  const cell = db.getCell(queryId, encodedKey)

  if (cell !== undefined && cell.verifiedAt === cur) {
    // Fast path: already verified at this revision.
    db.recordHit(queryId)
    trackParentDep(queryId, encodedKey, cell.changedAt)
    return cell.value as V
  }

  if (cell !== undefined && allDepsStable(db, cell, cur)) {
    // Slow path: deps haven't changed since we computed. Bump verifiedAt.
    cell.verifiedAt = cur
    db.recordHit(queryId)
    trackParentDep(queryId, encodedKey, cell.changedAt)
    return cell.value as V
  }

  // Recompute.
  return executeAndCache(db, queryId, encodedKey, key, fn, cell)
}

/**
 * Deep-verify : vérifier que tous les deps d'une cell sont à jour à la
 * revision courante. Si un dep est lui-même obsolète, on le réveille
 * récursivement avant de comparer son changedAt.
 *
 * Pour un dep INPUT : son verifiedAt est toujours == sa changedAt (l'input
 * est confirmé à jour dès qu'on l'a set). Pas besoin de réveiller.
 *
 * Pour un dep DERIVED : si son verifiedAt < cur, on rappelle la fonction
 * via runDerived(). Cela peut soit confirmer la cell (changedAt inchangé),
 * soit recomputer (changedAt bumpé). On compare ensuite avec cell.computedAt.
 *
 * Cas de rejet : dep disparu, ou dep.changedAt > cell.computedAt après deep-
 * verify. Dans les deux cas, la cell n'est plus valide.
 */
function allDepsStable(db: Database, cell: Cell, cur: Revision): boolean {
  for (const dep of cell.deps) {
    let depCell = db.getCell(dep.queryId, dep.encodedKey)
    if (!depCell) return false                          // dep disappeared

    // Si la dep est derived et pas vérifiée à cette revision, la réveiller.
    // Le wake-up peut soit confirmer la cell (changedAt inchangé), soit la
    // recomputer (changedAt bumpé) — dans tous les cas il faut RE-LIRE la
    // cell pour voir l'état post-wake-up.
    if (depCell.verifiedAt < cur) {
      const fn = db.getDerivedFn(dep.queryId)
      if (fn) {
        wakeUpDerivedDep(db, dep.queryId, dep.encodedKey, fn)
        const refreshed = db.getCell(dep.queryId, dep.encodedKey)
        if (!refreshed) return false
        depCell = refreshed
      }
    }

    if (depCell.changedAt > cell.computedAt) return false
  }
  return true
}

/**
 * Réveiller une derived dep depuis allDepsStable. Le but est de faire en
 * sorte que sa cell ait verifiedAt = cur (et changedAt à jour) après
 * l'appel. Réutilise runDerived avec une key décodée depuis encodedKey.
 *
 * Note : on perd l'info de la "vraie" key originale puisqu'on n'a stocké
 * que sa forme encodée. Mais le fn n'a pas besoin de la key décodée —
 * il l'a déjà via encodedKey lors du premier compute (qui a stocké les
 * deps). On rappelle donc avec la même key string que ce que le caller
 * original avait → encodage identique → bon Cell.
 *
 * En réalité on rappelle runDerived avec la key décodée d'origine. Comme
 * encodeKey est injective (préfixe par type), on peut décoder.
 */
function wakeUpDerivedDep(
  db: Database,
  queryId: QueryId,
  encodedKey: EncodedKey,
  fn: (key: unknown) => unknown,
): void {
  const key = decodeKey(encodedKey)
  // "Isolated" frame : un Frame neuf qu'on jette après — empêche
  // trackParentDep de polluer la frame appelante. inFlight propre permet
  // à executeAndCache de détecter ses propres cycles sans inclure les
  // queries en cours du caller (qui ne sont pas concernées par ce wake-up).
  const isolatedFrame: Frame = {
    queryId: '<wake-up>',
    encodedKey: '',
    deps: [],
    inFlight: new Set(),
  }
  als.run(isolatedFrame, () => {
    runDerived(db, queryId, encodedKey, key, fn)
  })
}

/**
 * Décode un EncodedKey vers sa forme originale. Inverse de `encodeKey`.
 * Doit produire une valeur qui re-encode vers la même string.
 *
 * Limite v1 : les tuples sont 1-level (items uniquement string/number).
 * encodeKey n'autorise pas explicitement nested mais le ferait silencieusement ;
 * decodeKey échoue proprement sur ce cas (split sur \x01 n'inverse pas les
 * nested). Pour rester safe : enforce dans encodeKey si besoin futur.
 */
function decodeKey(encoded: EncodedKey): QueryKey {
  if (encoded.startsWith('s\x00')) return encoded.slice(2)
  if (encoded.startsWith('n\x00')) return Number(encoded.slice(2))
  if (encoded.startsWith('t')) {
    // Format produit par encodeKey : 't\x01<item0>\x01<item1>...'
    const rest = encoded.slice(1)
    if (rest.length === 0) return []
    if (rest[0] !== '\x01') return []
    const items = rest.slice(1).split('\x01')
    return items.map((s) => {
      if (s.startsWith('s\x00')) return s.slice(2)
      if (s.startsWith('n\x00')) return Number(s.slice(2))
      throw new SalsaError('decode.unsupportedTupleItem',
        `cannot decode tuple item '${s.slice(0, 4)}…' (nested tuples not supported v1)`)
    })
  }
  throw new SalsaError('decode.unknownPrefix',
    `unknown encoded key prefix in '${encoded.slice(0, 4)}…'`)
}

function executeAndCache<K, V>(
  db: Database,
  queryId: QueryId,
  encodedKey: EncodedKey,
  key: K,
  fn: (key: K) => V,
  oldCell: Cell | undefined,
): V {
  const cur = db.currentRevision()
  const parentFrame = als.getStore()
  const inFlight = parentFrame ? parentFrame.inFlight : new Set<string>()
  const flightKey = queryId + '\x00' + encodedKey
  if (inFlight.has(flightKey)) {
    throw new SalsaError('cycle',
      `cycle detected involving query '${queryId}' on key '${encodedKey}'`)
  }
  inFlight.add(flightKey)

  const frame: Frame = {
    queryId, encodedKey,
    deps: [],
    inFlight,
  }
  let value: V
  try {
    value = als.run(frame, () => fn(key))
  } finally {
    inFlight.delete(flightKey)
  }

  // Detect "no-op recompute" : same value as before → keep `changedAt` as
  // the previous one. Crucial : permet au downstream de skipper s'il dépend
  // de cette query mais que la valeur n'a pas changé.
  const sameValue = oldCell !== undefined && Object.is(oldCell.value, value)
  const changedAt = sameValue
    ? oldCell.changedAt
    : (oldCell ? cur : (cur === REVISION_ZERO ? cur : cur))
  // ^ Note: at REVISION_ZERO no input has been set yet — derived queries
  // shouldn't be called. If somehow they are, treat as fresh.

  const cell: Cell = {
    queryId, encodedKey,
    value,
    deps: frame.deps,
    changedAt,
    computedAt: cur,
    verifiedAt: cur,
  }
  db.setCell(cell)
  db.recordMiss(queryId)
  trackParentDep(queryId, encodedKey, cell.changedAt)
  return value
}

function trackParentDep(
  queryId: QueryId, encodedKey: EncodedKey, seenAt: Revision,
): void {
  const parent = als.getStore()
  if (!parent) return
  parent.deps.push({ queryId, encodedKey, seenAt })
}
