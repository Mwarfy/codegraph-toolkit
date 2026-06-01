// ADR-028
/**
 * Compaction du fact-store content-addressed (cf. ADR-027 Phase 3).
 *
 * Le `facts.store.ndjson` est append-only par construction. Pour borner
 * sa taille, cette compaction supprime les facts qui ne sont plus
 * référencés par AUCUN head/base actif :
 *
 *   referenced = union(
 *     facts.head.json.byRelation.values(),
 *     facts.bases/<sha>.json[*] for last `keepBases` (LRU mtime)
 *   )
 *
 * Triggers :
 *   - Manuel : `codegraph compact [--dry-run]`
 *   - Auto post-analyze : si `orphans/total > maxOrphanRatio` OU
 *     `store size > maxSizeBytes`
 *
 * Atomicité : tmp file + rename. Aucun lock global — 2 compactions
 * concurrentes : un perd, l'autre gagne (no-op silencieux côté loser).
 *
 * Cf. ADR-028 pour le rationale.
 */

import * as fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import * as path from 'node:path'
import * as readline from 'node:readline'
import {
  factStorePath,
  basesDir,
  readFactsHead,
  type FactsHead,
} from './fact-store.js'

export interface CompactionConfig {
  /** Ratio orphelins/total au-delà duquel auto-trigger (default 0.30). */
  maxOrphanRatio: number
  /** Taille store (bytes) au-delà de laquelle auto-trigger (default 50 MB). */
  maxSizeBytes: number
  /** Nombre de bases LRU à garder (default 10). */
  keepBases: number
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  maxOrphanRatio: 0.30,
  maxSizeBytes: 50 * 1024 * 1024,
  keepBases: 10,
}

export interface CompactionResult {
  /** Facts conservés (référencés). */
  kept: number
  /** Facts supprimés (orphelins). */
  removed: number
  /** Bases LRU supprimées (au-delà de `keepBases`). */
  basesPruned: number
  /** Bytes libérés (size avant - après). */
  freedBytes: number
  /** Wall-clock ms. */
  durationMs: number
  /** Si true, seulement compté (pas de write). */
  dryRun: boolean
}

/**
 * Décide si une compaction est utile. Compte les orphelins via un scan
 * du store + comparaison au set référencé. Retourne `null` si pas de
 * store, sinon les stats + le verdict `shouldCompact`.
 */
export async function shouldCompact(
  snapshotDir: string,
  config: CompactionConfig = DEFAULT_COMPACTION_CONFIG,
): Promise<{
  total: number
  orphans: number
  sizeBytes: number
  shouldCompact: boolean
  reason?: 'orphans' | 'size'
} | null> {
  const storeFile = factStorePath(snapshotDir)
  let sizeBytes: number
  try {
    sizeBytes = (await fs.stat(storeFile)).size
  } catch {
    return null
  }

  const referenced = await collectReferencedIds(snapshotDir, config.keepBases)
  let total = 0
  let orphans = 0
  for await (const line of streamLines(storeFile)) {
    if (!line) continue
    total++
    try {
      const parsed = JSON.parse(line) as { id?: string }
      if (typeof parsed.id !== 'string' || !referenced.has(parsed.id)) {
        orphans++
      }
    } catch {
      orphans++  // ligne corrompue = à supprimer
    }
  }

  const orphanRatio = total > 0 ? orphans / total : 0
  let shouldCompactFlag = false
  let reason: 'orphans' | 'size' | undefined
  if (orphanRatio > config.maxOrphanRatio) {
    shouldCompactFlag = true
    reason = 'orphans'
  } else if (sizeBytes > config.maxSizeBytes) {
    shouldCompactFlag = true
    reason = 'size'
  }
  return { total, orphans, sizeBytes, shouldCompact: shouldCompactFlag, reason }
}

/**
 * Exécute la compaction. Atomique : écrit `facts.store.ndjson.compacting`
 * puis `fs.rename` vers la destination finale. En cas de crash : le tmp
 * est orphelin, le store original reste intact.
 *
 * Si `dryRun` est true, ne réécrit rien mais retourne les stats.
 */
export async function compactFactStore(
  snapshotDir: string,
  config: CompactionConfig = DEFAULT_COMPACTION_CONFIG,
  opts: { dryRun?: boolean } = {},
): Promise<CompactionResult> {
  const t0 = performance.now()
  const storeFile = factStorePath(snapshotDir)

  // 1. Prune les bases LRU au-delà de `keepBases` (si applicable).
  const basesPruned = await pruneOldBases(snapshotDir, config.keepBases, { dryRun: opts.dryRun ?? false })

  // 2. Recharge le set référencé (après prune des bases).
  const referenced = await collectReferencedIds(snapshotDir, config.keepBases)

  // 3. Stream + filter : compte seul si dryRun, sinon réécrit le store.
  const sizeBefore = await fileSize(storeFile)
  const { kept, removed } = opts.dryRun
    ? await countFilteredLines(storeFile, referenced)
    : await rewriteStoreFiltered(storeFile, referenced)
  const sizeAfter = await fileSize(storeFile)

  return {
    kept,
    removed,
    basesPruned,
    freedBytes: Math.max(0, sizeBefore - sizeAfter),
    durationMs: performance.now() - t0,
    dryRun: opts.dryRun ?? false,
  }
}

/** Une ligne du store est-elle référencée ? Ligne corrompue = non (dropped). */
function lineIsReferenced(line: string, referenced: Set<string>): boolean {
  try {
    const parsed = JSON.parse(line) as { id?: string }
    return typeof parsed.id === 'string' && referenced.has(parsed.id)
  } catch {
    return false
  }
}

/** Taille du fichier en bytes, 0 si absent. */
async function fileSize(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).size
  } catch {
    return 0
  }
}

/** Compte kept/removed sans écrire (dry-run). */
async function countFilteredLines(
  storeFile: string,
  referenced: Set<string>,
): Promise<{ kept: number; removed: number }> {
  let kept = 0
  let removed = 0
  for await (const line of streamLines(storeFile)) {
    if (!line) continue
    if (lineIsReferenced(line, referenced)) kept++
    else removed++
  }
  return { kept, removed }
}

/**
 * Réécrit le store en ne gardant que les lignes référencées. Atomique :
 * tmp + `fs.rename`. Streaming pour éviter de tout charger en RAM.
 */
async function rewriteStoreFiltered(
  storeFile: string,
  referenced: Set<string>,
): Promise<{ kept: number; removed: number }> {
  const tmp = storeFile + '.compacting'
  let kept = 0
  let removed = 0
  const handle = await fs.open(tmp, 'w')
  try {
    for await (const line of streamLines(storeFile)) {
      if (!line) continue
      if (lineIsReferenced(line, referenced)) {
        // await-ok: écriture séquentielle ordonnée du store (streaming, pas de Promise.all)
        await handle.write(line + '\n', null, 'utf-8')
        kept++
      } else {
        removed++
      }
    }
  } finally {
    await handle.close()
  }
  // Rename atomique — si un autre process a déjà compacté, on overwrite
  // (fs.rename remplace sans warning sur POSIX). Race rare : cleanup le tmp.
  try {
    await fs.rename(tmp, storeFile)
  } catch {
    try { await fs.unlink(tmp) } catch { /* nothing */ }
  }
  return { kept, removed }
}

/**
 * Collecte l'union des fact_ids référencés par le HEAD + les `keepBases`
 * bases les plus récentes (LRU par mtime). Au-delà, les bases sont
 * candidates à suppression mais cette fonction ne les supprime PAS —
 * c'est `pruneOldBases` qui s'en charge.
 */
async function collectReferencedIds(
  snapshotDir: string,
  keepBases: number,
): Promise<Set<string>> {
  const referenced = new Set<string>()

  // HEAD courant.
  const head = await readFactsHead(snapshotDir)
  if (head) addIdsFrom(head, referenced)

  // N bases LRU — lectures indépendantes, parallélisées (ordre indifférent :
  // on agrège dans un Set).
  const bases = await listBasesByMtime(snapshotDir)
  const baseHeads = await Promise.all(
    bases.slice(0, keepBases).map(async ({ path: p }): Promise<FactsHead | null> => {
      try {
        const parsed = JSON.parse(await fs.readFile(p, 'utf-8')) as FactsHead
        return parsed.version === 1 && parsed.byRelation ? parsed : null
      } catch {
        return null  // base corrompue : skip
      }
    }),
  )
  for (const h of baseHeads) {
    if (h) addIdsFrom(h, referenced)
  }
  return referenced
}

function addIdsFrom(head: FactsHead, target: Set<string>): void {
  for (const ids of Object.values(head.byRelation)) {
    for (const id of ids) target.add(id)
  }
}

/**
 * Liste les bases triées par mtime descendant (plus récent first).
 * Format : `facts.bases/<sha>.json`.
 */
async function listBasesByMtime(
  snapshotDir: string,
): Promise<{ path: string; mtime: number }[]> {
  const dir = basesDir(snapshotDir)
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }
  const stated = await Promise.all(
    entries
      .filter((e) => e.endsWith('.json'))
      .map(async (e) => {
        const p = path.join(dir, e)
        try {
          const st = await fs.stat(p)
          return { path: p, mtime: st.mtimeMs }
        } catch {
          return null
        }
      }),
  )
  return stated
    .filter((s): s is { path: string; mtime: number } => s !== null)
    .sort((a, b) => b.mtime - a.mtime)
}

/**
 * Supprime les bases au-delà de `keepBases` (= les moins récentes).
 * Retourne le nombre supprimé. Skip si `dryRun`.
 */
async function pruneOldBases(
  snapshotDir: string,
  keepBases: number,
  opts: { dryRun: boolean },
): Promise<number> {
  const bases = await listBasesByMtime(snapshotDir)
  if (bases.length <= keepBases) return 0
  const toDelete = bases.slice(keepBases)
  if (opts.dryRun) return toDelete.length
  const results = await Promise.all(
    toDelete.map(async (b): Promise<number> => {
      try {
        await fs.unlink(b.path)
        return 1
      } catch {
        return 0
      }
    }),
  )
  return results.reduce((a, b) => a + b, 0)
}

/**
 * Stream un fichier ligne par ligne via readline. Évite de charger
 * 100 MB en RAM. Retourne aussi les lignes vides (caller filtre).
 */
async function* streamLines(file: string): AsyncIterable<string> {
  let exists = true
  try { await fs.access(file) } catch { exists = false }
  if (!exists) return
  const stream = createReadStream(file, { encoding: 'utf-8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of rl) {
    yield line
  }
}
