// ADR-008
/**
 * Disk cache load/save pour le mode incremental — extrait du god-file
 * `core/analyzer.ts` (split P3a).
 *
 * Le cache persiste cells + mtimes dans `.codegraph/salsa-cache.json` pour
 * qu'un 2e `codegraph analyze --incremental` (CLI nouveau process) bénéficie
 * du warm.
 *
 * Sprint 9 : `skipPersistenceLoad/Save` permet au watcher de garder la DB
 * en RAM entre changes (le watcher save périodiquement ou au stop, pas
 * à chaque change qui écrirait ~3 MB à chaque fois).
 */

import {
  getMtimeMap as incGetMtimeMap,
  loadMtimeMap as incLoadMtimeMap,
} from '../../incremental/queries.js'
import {
  loadPersistedCache as incLoadPersistedCache,
  savePersistedCache as incSavePersistedCache,
} from '../../incremental/persistence.js'
import { sharedDb as incSharedDb } from '../../incremental/database.js'
import type { CodeGraphConfig } from '../types.js'

/**
 * Si on a un .codegraph/salsa-cache.json valide, restaure les cells + mtimes
 * AVANT toute autre étape. Permet le warm cross-process via CLI : 2e
 * `codegraph analyze --incremental` benéficie du cache disque même dans
 * un nouveau process.
 *
 * Sprint 9 : skipPersistenceLoad permet au watcher de ne pas relire le
 * disque entre analyzes (la DB reste en RAM).
 */
export async function loadDiskCacheIfIncremental(
  config: CodeGraphConfig,
  incremental: boolean,
  skipPersistenceLoad: boolean,
): Promise<void> {
  if (!incremental || skipPersistenceLoad) return
  try {
    const loaded = await incLoadPersistedCache(config.rootDir, incSharedDb)
    if (loaded) incLoadMtimeMap(loaded.mtimes)
  } catch {
    // Cache corrompu — on continue cold, save écrasera au final.
  }
}

/**
 * À la fin d'un run incremental, sauve cells + mtimes pour qu'un process
 * ultérieur (CLI) bénéficie du warm.
 *
 * Sprint 9 : skipPersistenceSave permet au watcher de ne pas écrire ~3 MB
 * à chaque change. Le caller du watcher save périodiquement ou au stop.
 */
export async function persistDiskCacheIfIncremental(
  config: CodeGraphConfig,
  incremental: boolean,
  skipPersistenceSave: boolean,
): Promise<void> {
  if (!incremental || skipPersistenceSave) return
  try {
    await incSavePersistedCache(config.rootDir, incGetMtimeMap(), incSharedDb)
  } catch {
    // Échec de save = pas bloquant. Le run a réussi.
  }
}
