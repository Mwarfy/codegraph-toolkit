/**
 * Core types for the Salsa-style incremental runtime.
 *
 * Vocabulaire :
 *   - Query           : fonction memoizée. Identifiée par (queryId, key).
 *                        `key` est l'argument (ex: un path de fichier). `queryId`
 *                        est le nom unique de la query (ex: "parseFile").
 *   - InputQuery      : query primitive — sa valeur est SET de l'extérieur.
 *                        Pas de fonction de calcul. Toute query qui en dépend
 *                        est invalidée au set.
 *   - DerivedQuery    : query avec une fonction de calcul. Ses dépendances
 *                        sont capturées automatiquement à l'exécution.
 *   - Revision        : entier monotone croissant. Chaque set d'input incrémente
 *                        la revision globale. La revision sert d'horloge pour
 *                        comparer "j'ai été calculé à R5, mes deps ont changé en R3 → OK".
 *   - Cell            : un slot de cache pour (queryId, key). Stocke la dernière
 *                        valeur, ses deps lues, et les revisions où la valeur a
 *                        été calculée vs où on l'a "verifiée" comme à jour.
 *
 * Sémantique de validité (red/green algorithm simplifié) :
 *   Un Cell est "à jour" à la revision R ssi :
 *     - cell.verifiedAt >= R  (déjà vérifié à cette révision)
 *     - OU pour TOUS les deps : dep.changedAt <= cell.computedAt (rien n'a changé en aval)
 *   Sinon → recompute.
 *
 * Différence avec Salsa-rs : on n'a pas de "durability" niveaux, pas de cycle
 * fixed-point, pas de salsa::tracked structs. Le sous-ensemble couvre 90% des
 * cas codegraph (queries acycliques sur un set fini de keys). Cf. README.
 */

// ─── Revisions ──────────────────────────────────────────────────────────────

/**
 * Revision monotone. Une seule par Database, incrémentée à chaque set d'input.
 * 0 = état initial (avant le 1er set).
 */
export type Revision = number

export const REVISION_ZERO: Revision = 0

// ─── Query identity ─────────────────────────────────────────────────────────

/**
 * Un nom unique de query. Convention : camelCase, descriptif (`parseFile`,
 * `importsOf`). Sert de namespace dans le storage interne.
 */
export type QueryId = string

/**
 * Un argument de query. Doit être stable (égalité structurelle bon marché)
 * et serializable. En pratique : string, number, ou tuple de tels.
 *
 * Pour les keys complexes (objet) le caller doit fournir un `keyEncoder`.
 */
export type QueryKey = string | number | readonly (string | number)[]

/**
 * Encoded form (string) d'une key. Utilisée pour le lookup interne.
 * Un même tuple → même string → même cell.
 */
export type EncodedKey = string

// ─── Cells ──────────────────────────────────────────────────────────────────

/**
 * Une dépendance enregistrée pendant l'exécution d'une query.
 * `seenAt` est la revision à laquelle on a observé la valeur upstream.
 */
export interface Dep {
  queryId: QueryId
  encodedKey: EncodedKey
  /** Revision de la valeur upstream lue (= sa `changedAt`). */
  seenAt: Revision
}

/**
 * Un slot de cache pour une (queryId, key).
 *
 * `value` est typé via les helpers — au niveau core on stocke `unknown`.
 *
 * `changedAt` : revision où la valeur a réellement changé pour la dernière
 * fois (utilisée par les downstream pour decider de recomputer).
 *
 * `computedAt` : revision à laquelle on a EXÉCUTÉ la fonction qui a produit
 * `value`. Borne basse pour la check de validité.
 *
 * `verifiedAt` : revision à laquelle on a confirmé que `value` est encore
 * correcte (sans la recomputer). Sert à éviter les re-checks O(deps) en
 * cascade. Optimisation classique de Salsa.
 */
export interface Cell {
  queryId: QueryId
  encodedKey: EncodedKey
  value: unknown
  deps: Dep[]
  changedAt: Revision
  computedAt: Revision
  verifiedAt: Revision
}

// ─── Errors ─────────────────────────────────────────────────────────────────

/**
 * Erreur générique du runtime. Code stable pour le filtrage.
 */
export class SalsaError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'SalsaError'
  }
}
