/**
 * Incremental Salsa database — singleton partagé pour le pipeline d'analyse.
 *
 * Sprint 2 (Phase 1 — Salsa migration) : 1 instance unique pour le process.
 * Reset via `db.reset()` quand on veut forcer un cold run (test, CLI flag
 * `--cold` à venir Sprint 4).
 *
 * Plus tard (Sprint 5 hypothétique) : persistence disque entre runs CLI
 * → cache hit même au démarrage à froid.
 */

import { Database } from '@liby/salsa'

export const sharedDb = new Database()
