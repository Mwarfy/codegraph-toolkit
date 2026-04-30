/**
 * Persistence disque pour le cache Salsa (Sprint 7 + delta saves Sprint 8).
 *
 * Format :
 *   - Baseline : `.codegraph/salsa-cache.json` — snapshot complet
 *   - Deltas : `.codegraph/salsa-delta-{NNN}.json` — append-only log
 *     des cells modifiées, numéroté par ordre.
 *
 * Stratégie de save :
 *   - Si pas de baseline OU dirtyRatio > 20% OU N deltas >= MAX_DELTAS
 *     → full save (réécrit baseline, supprime deltas).
 *   - Sinon → delta save (écrit le prochain salsa-delta-NNN.json).
 *
 * Le delta save sur Sentinel est ~10x plus rapide que le full save
 * quand 1 fichier change (sérialise ~10 cells au lieu de ~1500).
 *
 * Stratégie de load :
 *   - Charge baseline (loadState)
 *   - Charge tous les salsa-delta-NNN.json triés par NNN, applique
 *     dans l'ordre via applyDelta()
 *   - Au prochain save full, les deltas sont nettoyés
 *
 * Limites v1 :
 *   - Pas de compaction sélective. Le full save est tout-ou-rien.
 *   - Si le baseline est corrompu mais des deltas existent, on perd
 *     tout — recovery impossible. Acceptable parce que c'est un
 *     cache, pas une source primaire.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { sharedDb } from './database.js'
import type {
  Database,
  SerializedState,
  SerializedDelta,
} from '@liby/salsa'

const PERSIST_VERSION = 1
const MAX_DELTAS = 10
const DELTA_RATIO_THRESHOLD = 0.2

interface PersistedCache {
  version: number
  savedAt: string
  mtimes: Record<string, number>
  state: SerializedState
}

interface PersistedDelta {
  version: number
  savedAt: string
  /** Mtimes only for files modifiés depuis le delta précédent. */
  mtimes: Record<string, number>
  delta: SerializedDelta
}

function cachePath(rootDir: string): string {
  return path.join(rootDir, '.codegraph', 'salsa-cache.json')
}

function deltaDir(rootDir: string): string {
  return path.join(rootDir, '.codegraph')
}

function deltaFilename(n: number): string {
  return `salsa-delta-${n.toString().padStart(3, '0')}.json`
}

async function listDeltas(rootDir: string): Promise<string[]> {
  const dir = deltaDir(rootDir)
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }
  return entries
    .filter((e) => /^salsa-delta-\d+\.json$/.test(e))
    .sort()  // padding fixed-width → tri lex == tri numérique
    .map((e) => path.join(dir, e))
}

async function nextDeltaNumber(rootDir: string): Promise<number> {
  const deltas = await listDeltas(rootDir)
  if (deltas.length === 0) return 1
  const last = deltas[deltas.length - 1]
  const m = path.basename(last).match(/^salsa-delta-(\d+)\.json$/)
  return m ? parseInt(m[1], 10) + 1 : 1
}

/**
 * Charge le cache disque (baseline + deltas) dans la DB Salsa +
 * retourne les mtimes. Précondition : tous les `input()`/`derived()`
 * doivent déjà avoir été registered au load des modules incremental/*.
 *
 * Retourne `null` si le baseline n'existe pas, est invalide, ou a une
 * version incompatible. Si le baseline est OK mais un delta est
 * corrompu, on s'arrête au dernier delta valide (best-effort recovery).
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
  try { parsed = JSON.parse(raw) } catch { return null }
  if (parsed.version !== PERSIST_VERSION) return null
  if (!parsed.state || typeof parsed.state !== 'object') return null

  try {
    db.loadState(parsed.state)
  } catch {
    return null
  }

  const mtimes = new Map<string, number>()
  for (const [k, v] of Object.entries(parsed.mtimes ?? {})) {
    mtimes.set(k, v as number)
  }

  // Apply deltas in order. Best-effort : on s'arrête au premier delta
  // corrompu. La DB et les mtimes reflètent le dernier delta appliqué.
  const deltaFiles = await listDeltas(rootDir)
  for (const df of deltaFiles) {
    let dRaw: string
    try { dRaw = await fs.readFile(df, 'utf-8') } catch { break }
    let dParsed: PersistedDelta
    try { dParsed = JSON.parse(dRaw) } catch { break }
    if (dParsed.version !== PERSIST_VERSION) break
    try {
      db.applyDelta(dParsed.delta)
    } catch { break }
    for (const [k, v] of Object.entries(dParsed.mtimes ?? {})) {
      mtimes.set(k, v as number)
    }
  }

  return { mtimes }
}

/**
 * Sauve l'état courant de la DB + mtimes.
 *
 * Décide automatiquement entre full save (réécrit le baseline +
 * supprime les deltas) et delta save (append nouveau delta) selon
 * le ratio cells dirty / cells total et le nombre de deltas existants.
 *
 * Le `mtimes` passé doit être COMPLET (tous les fichiers, pas seulement
 * modifiés) — on l'utilise tel quel pour le full save, et pour les
 * delta saves on ne stocke que les mtimes nouveaux/changed depuis la
 * sauvegarde précédente (le caller gère ce filtrage si besoin ; ici
 * on stocke tout par simplicité — le merge au load garde la dernière
 * valeur lue).
 */
export async function savePersistedCache(
  rootDir: string,
  mtimes: Map<string, number>,
  db: Database = sharedDb,
): Promise<void> {
  const dir = deltaDir(rootDir)
  try { await fs.mkdir(dir, { recursive: true }) } catch {}

  const baselineExists = await fileExists(cachePath(rootDir))
  const existingDeltas = await listDeltas(rootDir)
  const dirty = db.dirtyCount()
  const total = db.totalCells()
  const dirtyRatio = total > 0 ? dirty / total : 1

  const shouldFull =
    !baselineExists ||
    existingDeltas.length >= MAX_DELTAS ||
    dirtyRatio > DELTA_RATIO_THRESHOLD ||
    dirty === total  // édge : tout est dirty (1er run)

  if (shouldFull) {
    await writeFullSnapshot(rootDir, mtimes, db)
    // Cleanup deltas — full snapshot englobe tout.
    for (const df of existingDeltas) {
      try { await fs.unlink(df) } catch {}
    }
    db.markPersisted()
    return
  }

  // Delta save : sérialise seulement les cells dirty.
  const n = await nextDeltaNumber(rootDir)
  const file = path.join(dir, deltaFilename(n))
  const payload: PersistedDelta = {
    version: PERSIST_VERSION,
    savedAt: new Date().toISOString(),
    mtimes: Object.fromEntries(mtimes),
    delta: db.serializeDirty(),
  }
  const tmp = file + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(payload), 'utf-8')
  await fs.rename(tmp, file)
  db.markPersisted()
}

async function writeFullSnapshot(
  rootDir: string,
  mtimes: Map<string, number>,
  db: Database,
): Promise<void> {
  const file = cachePath(rootDir)
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

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true } catch { return false }
}

/**
 * Force-supprime le cache (baseline + tous les deltas). Utile pour
 * `--cold` ou debug.
 */
export async function clearPersistedCache(rootDir: string): Promise<void> {
  try { await fs.unlink(cachePath(rootDir)) } catch {}
  for (const df of await listDeltas(rootDir)) {
    try { await fs.unlink(df) } catch {}
  }
}
