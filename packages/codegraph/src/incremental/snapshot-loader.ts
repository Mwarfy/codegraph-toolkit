// ADR-027
/**
 * Loader unifié pour le snapshot codegraph — point d'entrée canonique
 * pour TOUS les consumers (CLI commands, dashboard, MCP tools, dashboard
 * routes, hook impls).
 *
 * Pourquoi ce module existe :
 *   Post-Phase 2 (juin 2026), 8 consumers downstream lisaient le snapshot
 *   en dupliquant la logique « v2 + fallback legacy ». Quand le format a
 *   changé, on a dû patcher 8 fichiers en cascade. Cette dette est levée
 *   en centralisant la lecture : si le format évolue à nouveau (Phase 4,
 *   ADR-029, etc.), on touche UN fichier.
 *
 * Trois APIs :
 *   - `loadSnapshotPayload(dir)` : retourne le `GraphSnapshot` (unwrapped)
 *     ou null si absent. Le seul truc dont 95 % des callers ont besoin.
 *   - `loadStoredSnapshot(dir)` : retourne `{ meta, payload }` si v2,
 *     ou `{ meta: null, payload }` si legacy. Pour les callers qui ont
 *     besoin de la meta (refresh, dashboard meta endpoint).
 *   - `unwrapSnapshot(parsed)` : utility pure pour un blob déjà chargé.
 *
 * Tous les callers passent par ce module. Une future modif de format
 * (e.g. snapshot.json v3, format binaire RocksDB...) ne nécessite de
 * toucher que ce fichier.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { GraphSnapshot } from '../core/types.js'
import {
  readStoredSnapshot,
  listLegacySnapshots,
  snapshotPath as v2Path,
  type SnapshotMeta,
} from './snapshot-store.js'

export interface LoadedSnapshot {
  meta: SnapshotMeta | null
  payload: GraphSnapshot
  source: string
}

/**
 * Lecture canonique du snapshot pour les consumers — privilégie v2,
 * fallback sur le plus récent `snapshot-<ts>-<sha>.json` legacy.
 *
 * Retourne `null` si rien n'est lisible. Les callers décident s'ils
 * `process.exit(1)` ou retournent une erreur HTTP/MCP.
 */
export async function loadSnapshotPayload(
  snapshotDir: string,
): Promise<GraphSnapshot | null> {
  const loaded = await loadStoredSnapshot(snapshotDir)
  return loaded?.payload ?? null
}

/**
 * Variante qui expose aussi la meta (factSetHash, inputHash, etc.).
 * Utilisée par les consumers qui veulent valider la fraîcheur sans
 * relire le payload entier (refresh, dashboard /api/snapshot/meta).
 */
export async function loadStoredSnapshot(
  snapshotDir: string,
): Promise<LoadedSnapshot | null> {
  // V2 path : .codegraph/snapshot.json wrappé { version, meta, payload }
  const stored = await readStoredSnapshot(snapshotDir)
  if (stored) {
    return {
      meta: stored.meta,
      payload: stored.payload,
      source: v2Path(snapshotDir),
    }
  }

  // Fallback legacy : dernier snapshot-<ts>-<sha>.json (lex-last
  // = timestamp le plus récent). Pas de meta.
  const legacy = await listLegacySnapshots(snapshotDir)
  if (legacy.length === 0) return null
  try {
    const raw = await fs.readFile(legacy[0], 'utf-8')
    const payload = JSON.parse(raw) as GraphSnapshot
    return { meta: null, payload, source: legacy[0] }
  } catch {
    return null
  }
}

/**
 * Lecture canonique depuis un PATH explicite (utilisée par les CLI
 * commands qui acceptent `--input <file>` ou les endpoints qui
 * acceptent un nom de fichier). Gère le unwrap v2 automatiquement.
 */
export async function loadSnapshotFromFile(
  filePath: string,
): Promise<GraphSnapshot | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    return unwrapSnapshot(parsed)
  } catch {
    return null
  }
}

/**
 * Unwrap pure du wrapper v2 `{ version, meta, payload }`. Si l'argument
 * est déjà un `GraphSnapshot` plat (legacy), il est retourné tel quel.
 *
 * Utility partagé pour les consumers qui ont déjà chargé le JSON
 * (e.g. via une lib externe ou un test inline).
 */
export function unwrapSnapshot(parsed: unknown): GraphSnapshot {
  if (
    parsed &&
    typeof parsed === 'object' &&
    (parsed as { version?: number }).version === 2 &&
    (parsed as { payload?: unknown }).payload
  ) {
    return (parsed as { payload: GraphSnapshot }).payload
  }
  return parsed as GraphSnapshot
}

/**
 * Liste tous les fichiers snapshot disponibles dans le dossier — v2
 * canonique (+ son .bak) et legacy historiques. Utilisé par le dashboard
 * `/api/snapshots` et les outils de comparaison.
 *
 * Retourne les paths absolus, newest first.
 */
export async function listAllSnapshotPaths(
  snapshotDir: string,
): Promise<{ v2: string[]; legacy: string[]; all: string[] }> {
  const v2: string[] = []
  try {
    const dir = await fs.readdir(snapshotDir)
    if (dir.includes('snapshot.json')) v2.push(path.join(snapshotDir, 'snapshot.json'))
    if (dir.includes('snapshot.json.bak')) v2.push(path.join(snapshotDir, 'snapshot.json.bak'))
  } catch {
    /* dir absent */
  }
  const legacy = await listLegacySnapshots(snapshotDir)
  return { v2, legacy, all: [...v2, ...legacy] }
}

/**
 * Validation de nom de fichier — empêche le path traversal côté
 * routes HTTP/dashboard. Accepte v2 canonique + legacy regex strict.
 */
export function isSafeSnapshotFilename(name: string): boolean {
  const base = path.basename(name)
  if (base === 'snapshot.json' || base === 'snapshot.json.bak') return true
  return /^snapshot-\d{4}-\d{2}-\d{2}T.*\.json$/.test(base)
}
