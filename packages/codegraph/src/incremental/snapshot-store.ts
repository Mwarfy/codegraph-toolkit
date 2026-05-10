// ADR-027
/**
 * Storage du snapshot HEAD — fichier unique `.codegraph/snapshot.json`
 * + sidecar `.codegraph/snapshot.meta.json`. Remplace les
 * `snapshot-<ts>-<sha>.json` cumulatifs (Phase 1 puis Phase 2 d'ADR-027).
 *
 * Deux fichiers :
 *   - `snapshot.json`        : payload `GraphSnapshot` + meta inline
 *   - `snapshot.meta.json`   : meta seul, sidecar pour staleness check
 *                              rapide (~1ms) sans parser le blob 3 MB
 *
 * `snapshot.json` reste la source de vérité — le meta y est dupliqué.
 * Le sidecar est un cache dérivable, écrit en même temps via la même
 * opération atomique (tmp → rename).
 *
 * N=2 backup : à chaque écriture, l'ancien `snapshot.json` est conservé
 * en `snapshot.json.bak` pour rollback manuel si une régression
 * structurelle est détectée. Pas de log historique au-delà.
 *
 * Phase 2 d'ADR-027.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { GraphSnapshot } from '../core/types.js'

export const SNAPSHOT_VERSION = 2

const SNAPSHOT_FILE = 'snapshot.json'
const SNAPSHOT_BACKUP = 'snapshot.json.bak'
const META_FILE = 'snapshot.meta.json'

export interface SnapshotMeta {
  /** Version du schéma du fichier snapshot (= 2 pour Phase 2). */
  version: number
  /** Content-addressed hash des inputs (cf. input-hash.ts). */
  inputHash: string
  /** ISO 8601 du moment d'écriture. */
  generatedAt: string
  /** Hash git du HEAD au moment de l'écriture (info, non-authoritative). */
  baseSha?: string
  /** Nombre de fichiers entrés dans le inputHash (info debug). */
  fileCount?: number
  /** Version du tooling utilisé (info debug). */
  toolingVersion?: string
  // ADR-027 Phase 3 — fingerprint du fact set (hash trié des fact_ids).
  // Présent quand le pipeline Datalog a tourné (= bundle disponible).
  // Permet aux consumers de vérifier l'identité du fact store sans le
  // re-lire entièrement.
  factSetHash?: string
}

export interface StoredSnapshot {
  meta: SnapshotMeta
  payload: GraphSnapshot
}

export function snapshotPath(snapshotDir: string): string {
  return path.join(snapshotDir, SNAPSHOT_FILE)
}

export function snapshotMetaPath(snapshotDir: string): string {
  return path.join(snapshotDir, META_FILE)
}

export function snapshotBackupPath(snapshotDir: string): string {
  return path.join(snapshotDir, SNAPSHOT_BACKUP)
}

/**
 * Lit uniquement la meta — fast path pour staleness check. Si le
 * sidecar manque mais que `snapshot.json` existe, on extrait la meta
 * depuis le payload (fallback dégradé, plus lent).
 *
 * Retourne `null` si rien n'est lisible — le caller saura repartir
 * cold.
 */
export async function readSnapshotMeta(
  snapshotDir: string,
): Promise<SnapshotMeta | null> {
  // Fast path : sidecar dédié.
  const sidecarPath = snapshotMetaPath(snapshotDir)
  try {
    const raw = await fs.readFile(sidecarPath, 'utf-8')
    const parsed = JSON.parse(raw) as SnapshotMeta
    if (typeof parsed?.inputHash === 'string') return parsed
  } catch {
    /* fall through to full read */
  }

  // Fallback : extrait la meta depuis le payload.
  const stored = await readStoredSnapshot(snapshotDir)
  return stored?.meta ?? null
}

/**
 * Lit le snapshot complet (meta + payload). Retourne `null` si le
 * fichier est absent, corrompu, ou d'une version incompatible. Cas
 * d'erreur silencieux : le caller décide d'un fallback (legacy ou
 * cold analyze).
 */
export async function readStoredSnapshot(
  snapshotDir: string,
): Promise<StoredSnapshot | null> {
  const file = snapshotPath(snapshotDir)
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf-8')
  } catch {
    return null
  }

  let parsed: { version?: number; meta?: SnapshotMeta; payload?: GraphSnapshot }
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (
    !parsed ||
    parsed.version !== SNAPSHOT_VERSION ||
    !parsed.meta ||
    typeof parsed.meta.inputHash !== 'string' ||
    !parsed.payload
  ) {
    return null
  }

  return { meta: parsed.meta, payload: parsed.payload }
}

/**
 * Écrit le snapshot atomiquement (tmp + rename). Conserve l'ancien en
 * `.bak` (N=2). Écrit aussi le sidecar meta dans la foulée — les deux
 * renames ne sont pas globalement atomiques, mais une window inférieure
 * à 1ms reste acceptable (au pire, le sidecar pointe vers l'ancien
 * meta jusqu'au rename suivant, le full read tombe sur le nouveau).
 *
 * Le caller est responsable de calculer `meta.inputHash` via
 * `computeInputHash()`.
 */
export async function writeStoredSnapshot(
  snapshotDir: string,
  meta: SnapshotMeta,
  payload: GraphSnapshot,
): Promise<void> {
  await fs.mkdir(snapshotDir, { recursive: true })

  const file = snapshotPath(snapshotDir)
  const sidecar = snapshotMetaPath(snapshotDir)
  const backup = snapshotBackupPath(snapshotDir)

  // Rotate current → .bak (best-effort — pas de bak si pas de fichier
  // pre-existant).
  try {
    await fs.copyFile(file, backup)
  } catch {
    /* premier write, ou copyFile pas supporté — on laisse passer */
  }

  const fullPayload = {
    version: SNAPSHOT_VERSION,
    meta,
    payload,
  }
  await writeAtomic(file, JSON.stringify(fullPayload))
  await writeAtomic(sidecar, JSON.stringify(meta, null, 2))
}

async function writeAtomic(target: string, content: string): Promise<void> {
  const tmp = target + '.tmp'
  await fs.writeFile(tmp, content, 'utf-8')
  await fs.rename(tmp, target)
}

/**
 * Liste les anciens snapshots cumulatifs `snapshot-<ts>-<sha>.json`
 * (format Phase 1 / pré-Phase-2). Utilisé pour la migration douce —
 * `loadSnapshot` les lit en fallback, et `pruneLegacySnapshots` les
 * supprime progressivement après migration.
 */
export async function listLegacySnapshots(snapshotDir: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(snapshotDir)
  } catch {
    return []
  }
  return entries
    .filter((f) => /^snapshot-\d{4}-\d{2}-\d{2}T.*\.json$/.test(f))
    .sort()
    .reverse()  // newest first
    .map((f) => path.join(snapshotDir, f))
}
