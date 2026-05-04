// ADR-007
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
} from '@liby-tools/salsa'

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
  const baseline = await loadBaselineSnapshot(cachePath(rootDir), db)
  if (!baseline) return null

  await applyDeltasInOrder(rootDir, baseline.mtimes, db)
  return { mtimes: baseline.mtimes }
}

/**
 * Lit le baseline + applique loadState sur la DB. Retourne null si fichier
 * absent, JSON invalide, version mismatch, state invalide, ou loadState
 * throw — tout ça = on retourne cold (le caller saura repartir).
 */
async function loadBaselineSnapshot(
  file: string,
  db: Database,
): Promise<{ mtimes: Map<string, number> } | null> {
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
  return { mtimes }
}

/**
 * Applique les deltas dans l'ordre. Best-effort : on s'arrête au premier
 * delta corrompu / version mismatch / applyDelta throw. La DB et les mtimes
 * reflètent le dernier delta valide appliqué.
 *
 * Optim 2026-05-04 : les LECTURES disque sont parallélisées (Promise.all),
 * l'APPLICATION reste séquentielle (db.applyDelta accumule, ordre critique).
 * Mesure runtime probe : tryApplyDeltaFile était top hot symbol score 3844
 * (count=62 × p95=62ms). Cause = sequential await fs.readFile dans la loop.
 * Trade-off : si premier delta foire, on aura quand même lu les suivants —
 * gaspillé négligeable car erreur rare et reads sont I/O-light.
 */
async function applyDeltasInOrder(
  rootDir: string,
  mtimes: Map<string, number>,
  db: Database,
): Promise<void> {
  const deltaFiles = await listDeltas(rootDir)
  if (deltaFiles.length === 0) return

  // Read all delta files in parallel — order preservé via Promise.all index.
  const reads = await Promise.all(deltaFiles.map((df) => readDeltaFile(df)))

  // Apply sequentially in original order.
  for (const parsed of reads) {
    if (!parsed) break  // first failed read or invalid → stop accumulation
    if (!applyParsedDelta(parsed, db, mtimes)) break
  }
}

/**
 * Lit + parse + valide un delta file. Retourne null si fichier manquant,
 * JSON invalide, ou version mismatch — tous des cas "skip silencieusement".
 */
async function readDeltaFile(df: string): Promise<PersistedDelta | null> {
  let raw: string
  try { raw = await fs.readFile(df, 'utf-8') } catch { return null }
  let parsed: PersistedDelta
  try { parsed = JSON.parse(raw) } catch { return null }
  if (parsed.version !== PERSIST_VERSION) return null
  return parsed
}

/**
 * Applique un delta pré-lu sur la DB + merge les mtimes. Retourne false
 * si applyDelta throw (rollback impossible — on stop l'accumulation).
 */
function applyParsedDelta(
  parsed: PersistedDelta,
  db: Database,
  mtimes: Map<string, number>,
): boolean {
  try {
    db.applyDelta(parsed.delta)
  } catch {
    return false
  }
  for (const [k, v] of Object.entries(parsed.mtimes ?? {})) {
    mtimes.set(k, v as number)
  }
  return true
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
  try { await fs.mkdir(dir, { recursive: true }) } catch { /* dir existe déjà ou parent non-writable — writeFullSnapshot va lever clairement */ }

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
    // Cleanup deltas en parallèle — full snapshot englobe tout, indépendants.
    await Promise.all(
      existingDeltas.map(async (df) => {
        try { await fs.unlink(df) } catch { /* delta disparu (concurrent run) — déjà au but */ }
      }),
    )
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

