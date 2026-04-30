/**
 * @liby/salsa — public API.
 *
 * Salsa-style incremental computation in pure TypeScript. Pas de macro, pas
 * de codegen — juste deux fonctions : `input(db, id)` et `derived(db, id, fn)`.
 *
 * Quick start :
 *
 *   import { Database, input, derived } from '@liby/salsa'
 *
 *   const db = new Database()
 *   const fileContent = input<string, string>(db, 'fileContent')
 *   const wordCount   = derived<string, number>(db, 'wordCount',
 *     (path) => fileContent.get(path).split(/\s+/).length)
 *
 *   fileContent.set('a.txt', 'hello world')
 *   wordCount.get('a.txt')                  // 2 (computed)
 *   wordCount.get('a.txt')                  // 2 (cached)
 *   fileContent.set('a.txt', 'hello big world')
 *   wordCount.get('a.txt')                  // 3 (recomputed — dep changed)
 *
 * Voir README.md pour la sémantique de validation détaillée.
 */

export {
  Database,
  serializeValue,
  deserializeValue,
  type SerializedState,
  type SerializedCell,
  type SerializedDelta,
} from './database.js'
export { input, derived } from './runtime.js'
export type { InputQuery, DerivedQuery } from './runtime.js'
export { encodeKey } from './key-encoder.js'
export {
  REVISION_ZERO, SalsaError,
} from './types.js'
export type {
  Revision, QueryId, QueryKey, EncodedKey,
  Cell, Dep,
} from './types.js'
