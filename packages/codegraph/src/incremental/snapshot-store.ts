// ADR-027 + ADR-033
/**
 * Storage du snapshot HEAD — fichier principal `.codegraph/snapshot.json`
 * + sidecar `.codegraph/snapshot.meta.json` + sub-snapshots ADR-033.
 *
 * Phase 2 ADR-027 a posé le fat blob unique :
 *   - `snapshot.json`        : payload `GraphSnapshot` + meta inline
 *   - `snapshot.meta.json`   : meta seul, sidecar pour staleness check
 *                              rapide (~1ms) sans parser le blob 3 MB
 *
 * Phase 1 ADR-033 ajoute, en parallèle du fat blob (back-compat absolue) :
 *   - `snapshot.detectors/<field>.ndjson` : un fichier par champ de
 *                              `DetectorOutputs`. Array → 1 fact par ligne
 *                              (NDJSON canonique). Bundle objet (e.g.
 *                              `codeQualityPatterns`) → 1 ligne JSON unique.
 *   - `snapshot.metrics.json` : tous les champs de `SnapshotMetrics` agrégés
 *                              dans un objet unique.
 *
 * Le fat blob reste écrit (consumer externe Sentinel / codegraph-mcp /
 * hooks bash le lisent encore tel quel). Phase 2 ADR-033 ajoutera des
 * loaders lazy (`loadGraphCore`, `loadDetectorOutput`, `loadMetrics`)
 * par-dessus les sub-files. Phase 4 (lointaine) pourra retirer du fat blob
 * ce qui est dans les sub-files.
 *
 * Bump version : v2 = fat blob seul. v3 = fat blob + sub-files. La lecture
 * accepte les deux (migration douce, pas de breaking pour les consumers
 * externes qui peuvent encore lire des snapshots v2).
 *
 * N=2 backup : à chaque écriture, l'ancien `snapshot.json` est conservé
 * en `snapshot.json.bak` pour rollback manuel si une régression
 * structurelle est détectée. Pas de log historique au-delà.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { GraphSnapshot } from '../core/types.js'
import { DETECTOR_FIELDS, METRIC_FIELDS } from './snapshot-fields.js'

export const SNAPSHOT_VERSION = 3
/**
 * Versions du wrapper `snapshot.json` qui restent lisibles. v2 = fat blob
 * seul (Phase 2 ADR-027). v3 = fat blob + sub-files (Phase 1 ADR-033).
 * La lecture est tolérante aux deux pour ne pas casser les consumers
 * externes qui ont un snapshot v2 en cache.
 */
export const SUPPORTED_SNAPSHOT_VERSIONS = [2, 3] as const

const SNAPSHOT_FILE = 'snapshot.json'
const SNAPSHOT_BACKUP = 'snapshot.json.bak'
const META_FILE = 'snapshot.meta.json'
const DETECTORS_SUBDIR = 'snapshot.detectors'
const METRICS_FILE = 'snapshot.metrics.json'

export interface SnapshotMeta {
  /** Version du schéma du fichier snapshot (v3 = Phase 1 ADR-033). */
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
 * Dossier des sub-snapshots detector (ADR-033 Phase 1). Un fichier
 * `<field>.ndjson` par champ de `DetectorOutputs`.
 */
export function snapshotDetectorsDir(snapshotDir: string): string {
  return path.join(snapshotDir, DETECTORS_SUBDIR)
}

/**
 * Path d'un sub-snapshot detector spécifique (ADR-033 Phase 1).
 * Format NDJSON pour les Arrays, JSON ligne unique pour les bundles objet.
 */
export function snapshotDetectorPath(
  snapshotDir: string,
  detectorField: string,
): string {
  return path.join(snapshotDir, DETECTORS_SUBDIR, `${detectorField}.ndjson`)
}

/**
 * Path du sub-snapshot metrics agrégé (ADR-033 Phase 1). Objet JSON
 * imbriqué unique contenant tous les champs `SnapshotMetrics` non-undefined.
 */
export function snapshotMetricsPath(snapshotDir: string): string {
  return path.join(snapshotDir, METRICS_FILE)
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
 *
 * Migration douce ADR-033 : accepte v2 (fat blob seul) ET v3 (fat blob
 * + sub-files). Les sub-files ne sont pas re-lus ici — `payload` provient
 * du fat blob, qui contient tout par construction (cohabite jusqu'à
 * Phase 4 ADR-033).
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
    typeof parsed.version !== 'number' ||
    !(SUPPORTED_SNAPSHOT_VERSIONS as readonly number[]).includes(parsed.version) ||
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
 * ADR-033 Phase 1 : après le fat blob, écrit les sub-files en parallèle
 * (un fichier par detector + un fichier metrics agrégé). Le fat blob
 * reste authoritative — les sub-files sont une projection.
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

  // ADR-033 Phase 1 — sub-snapshots écrits en parallèle du fat blob.
  await writeSubSnapshots(snapshotDir, payload)
}

/**
 * ADR-033 Phase 1 — écrit les sub-snapshots à côté du fat blob.
 *
 * - `snapshot.detectors/<field>.ndjson` : un fichier par champ
 *   `DetectorOutputs` présent dans le payload. Array → un fact par ligne.
 *   Bundle objet (ex: `codeQualityPatterns`) → 1 ligne JSON unique.
 *   Champs absents → fichier non écrit (= signal "detector pas tourné").
 *
 * - `snapshot.metrics.json` : tous les champs `SnapshotMetrics` non-undefined
 *   agrégés dans un objet imbriqué unique (pretty-printed pour lisibilité).
 *
 * Aucune écriture n'est conditionnelle à la valeur — si `cycles: []` (array
 * vide), on écrit un fichier vide (signal "detector a tourné, zéro résultat",
 * sémantiquement distinct de "pas tourné").
 *
 * Pas de rotate `.bak` sur les sub-files — ils sont projection du fat blob
 * qui a déjà son backup. En cas de corruption d'un sub-file, relire le fat
 * blob redonne la vérité.
 */
/**
 * Sérialise la valeur d'un detector field : array → NDJSON (un JSON/ligne,
 * array vide → fichier vide = "detector a tourné, zéro résultat") ; objet
 * bundle → 1 ligne JSON.
 */
function serializeDetectorField(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length === 0
      ? ''
      : value.map((item) => JSON.stringify(item)).join('\n') + '\n'
  }
  return JSON.stringify(value) + '\n'
}

export async function writeSubSnapshots(
  snapshotDir: string,
  payload: GraphSnapshot,
): Promise<void> {
  // 1. Detector outputs — un fichier par detector field.
  const detectorsDir = snapshotDetectorsDir(snapshotDir)
  await fs.mkdir(detectorsDir, { recursive: true })

  // Écritures indépendantes (un fichier distinct par field) → parallèles.
  const detectorWrites: Promise<void>[] = []
  for (const field of DETECTOR_FIELDS) {
    const value = payload[field]
    if (value === undefined) continue
    const target = snapshotDetectorPath(snapshotDir, field)
    detectorWrites.push(writeAtomic(target, serializeDetectorField(value)))
  }
  await Promise.all(detectorWrites)

  // 2. Metrics — un seul fichier JSON imbriqué.
  const metricsBundle: Record<string, unknown> = {}
  for (const field of METRIC_FIELDS) {
    const value = payload[field]
    if (value !== undefined) {
      metricsBundle[field] = value
    }
  }
  await writeAtomic(
    snapshotMetricsPath(snapshotDir),
    JSON.stringify(metricsBundle, null, 2) + '\n',
  )
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
