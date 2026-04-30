/**
 * Persistence disque pour le cache Salsa (Sprint 7).
 *
 * Format : un fichier JSON par projet à `.codegraph/salsa-cache.json`.
 * Contient :
 *   - version : numéro de version du format. Mismatch → ignore (cold).
 *   - revision : la dernière revision globale Salsa.
 *   - mtimes : Map<relPath, mtimeMs> pour skip des reads inchangés.
 *   - cells : tableau de SerializedCell.
 *
 * Cycle de vie :
 *   1. analyze() incremental boot → loadPersistedCache(rootDir, db)
 *      restaure cells + mtimes si fichier valide.
 *   2. analyze() incremental fin → savePersistedCache(rootDir, db, mtimes)
 *      écrit le fichier mis à jour.
 *
 * Limites v1 :
 *   - Toutes les cells sont sérialisées à chaque save (pas de delta).
 *     Sur Sentinel ~1500 cells = ~5-10 MB. Acceptable.
 *   - Les cells dont les fns derived ne sont plus enregistrées (refactor
 *     du toolkit) restent dans le cache mais sont ignorées au wake-up.
 *     Pour invalider explicitement : suppression manuelle du fichier.
 *   - Pas de détection de version du toolkit (TODO Sprint 8+).
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { sharedDb } from './database.js'
import type { Database, SerializedState } from '@liby/salsa'

const PERSIST_VERSION = 1

interface PersistedCache {
  version: number
  /** Date ISO de la dernière sauvegarde (info debug). */
  savedAt: string
  /** mtime fs cache ; Map<relPath, mtimeMs>. */
  mtimes: Record<string, number>
  /** État Salsa sérialisé. */
  state: SerializedState
}

function cachePath(rootDir: string): string {
  return path.join(rootDir, '.codegraph', 'salsa-cache.json')
}

/**
 * Charge le cache disque dans la DB Salsa + retourne les mtimes.
 * Précondition : tous les `input()`/`derived()` doivent déjà avoir été
 * registered (les wrappers module-level le font au load des modules
 * incremental/*).
 *
 * Retourne `null` si le fichier n'existe pas, est invalide, ou a une
 * version incompatible — le caller continue en cold.
 */
export async function loadPersistedCache(
  rootDir: string,
  db: Database = sharedDb,
): Promise<{ mtimes: Map<string, number> } | null> {
  const file = cachePath(rootDir)
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf-8')
  } catch {
    return null
  }

  let parsed: PersistedCache
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (parsed.version !== PERSIST_VERSION) return null
  if (!parsed.state || typeof parsed.state !== 'object') return null

  try {
    db.loadState(parsed.state)
  } catch {
    return null  // version Salsa changée, format différent — fallback cold
  }

  const mtimes = new Map<string, number>()
  for (const [k, v] of Object.entries(parsed.mtimes ?? {})) {
    mtimes.set(k, v as number)
  }
  return { mtimes }
}

/**
 * Sauve l'état courant de la DB + mtimes. Écrit atomiquement via
 * fichier temporaire + rename pour éviter un cache corrompu si le
 * process est tué pendant l'écriture.
 */
export async function savePersistedCache(
  rootDir: string,
  mtimes: Map<string, number>,
  db: Database = sharedDb,
): Promise<void> {
  const file = cachePath(rootDir)
  const dir = path.dirname(file)
  try { await fs.mkdir(dir, { recursive: true }) } catch {}

  const payload: PersistedCache = {
    version: PERSIST_VERSION,
    savedAt: new Date().toISOString(),
    mtimes: Object.fromEntries(mtimes),
    state: db.serializeState(),
  }
  const tmp = file + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(payload), 'utf-8')
  await fs.rename(tmp, file)
}

/** Force-supprime le cache. Utile pour --cold ou debug. */
export async function clearPersistedCache(rootDir: string): Promise<void> {
  try { await fs.unlink(cachePath(rootDir)) } catch {}
}
