// ADR-027 + ADR-033
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
 * APIs disponibles :
 *
 * ── Loaders complets (ADR-027 Phase 2) ──
 *   - `loadSnapshotPayload(dir)` : retourne le `GraphSnapshot` (unwrapped)
 *     ou null si absent. Le seul truc dont 95 % des callers ont besoin.
 *   - `loadStoredSnapshot(dir)` : retourne `{ meta, payload }` si v2/v3,
 *     ou `{ meta: null, payload }` si legacy. Pour les callers qui ont
 *     besoin de la meta (refresh, dashboard meta endpoint).
 *   - `unwrapSnapshot(parsed)` : utility pure pour un blob déjà chargé.
 *
 * ── Loaders lazy par sous-domaine (ADR-033 Phase 2) ──
 *   - `loadGraphCore(dir)` : retourne juste `{ nodes, edges, stats,
 *     version, ... }`. Phase 2 : extrait depuis le fat blob. Phase 4 :
 *     lira directement snapshot.json (qui sera devenu graph core seul).
 *   - `loadDetectorOutput(dir, name)` : retourne juste les facts d'un
 *     detector. Priorise `snapshot.detectors/<name>.ndjson`, fallback fat
 *     blob (= snapshots v2 legacy).
 *   - `loadMetrics(dir)` : retourne `SnapshotMetrics`. Priorise
 *     `snapshot.metrics.json`, fallback fat blob.
 *
 * Tous les callers passent par ce module. Une future modif de format
 * (e.g. snapshot.json v4 sans le fat blob, format binaire RocksDB…) ne
 * nécessite de toucher que ce fichier.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type {
  DetectorOutputs,
  GraphCore,
  GraphSnapshot,
  SnapshotMetrics,
} from '../core/types.js'
import {
  readStoredSnapshot,
  listLegacySnapshots,
  snapshotPath as v2Path,
  snapshotDetectorPath,
  snapshotMetricsPath,
  type SnapshotMeta,
} from './snapshot-store.js'
import {
  DETECTOR_FIELD_KINDS,
  METRIC_FIELDS,
  type DetectorFieldName,
} from './snapshot-fields.js'

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
 * Versions du wrapper `{ version, meta, payload }` que ce loader sait lire.
 *
 * Source de vérité unique pour la détection « ce blob est-il un wrapper
 * versionné connu ? ». Tout consumer qui aurait été tenté de hardcoder
 * `parsed.version === 2` (ou `=== 3`) doit utiliser `isWrappedSnapshot`
 * ou `unwrapSnapshot` à la place, faute de quoi le bump suivant
 * (ADR-033 Phase 4 → v4) casse silencieusement en cascade — pattern
 * identifié dans l'audit dette architecturale 2026-05-12.
 */
export const WRAPPER_VERSIONS = [2, 3] as const
export type WrapperVersion = (typeof WRAPPER_VERSIONS)[number]

/**
 * True si `parsed` est un wrapper versionné connu (= `{ version, meta,
 * payload }` avec une `version` listée dans `WRAPPER_VERSIONS` et un
 * `payload` non vide). API publique — préfère ce helper à un check inline
 * pour que le bump v4 reste un changement à 1 fichier (snapshot-loader.ts).
 */
export function isWrappedSnapshot(parsed: unknown): parsed is {
  version: WrapperVersion
  payload: GraphSnapshot
  meta?: SnapshotMeta
} {
  if (!parsed || typeof parsed !== 'object') return false
  const v = (parsed as { version?: unknown }).version
  const payload = (parsed as { payload?: unknown }).payload
  return (
    typeof v === 'number' &&
    (WRAPPER_VERSIONS as readonly number[]).includes(v) &&
    payload != null
  )
}

/**
 * Unwrap pure du wrapper `{ version, meta, payload }`. Accepte les
 * versions listées dans `WRAPPER_VERSIONS` (v2 ADR-027 Phase 2 + v3
 * ADR-033 Phase 1 — wrapper structurellement identique). Si l'argument
 * est déjà un `GraphSnapshot` plat (legacy pré-v2), il est retourné tel
 * quel.
 *
 * Utility partagé pour les consumers qui ont déjà chargé le JSON
 * (e.g. via une lib externe ou un test inline).
 */
export function unwrapSnapshot(parsed: unknown): GraphSnapshot {
  if (isWrappedSnapshot(parsed)) return parsed.payload
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

// ─── ADR-033 Phase 2 — Loaders lazy par sous-domaine ──────────────────────

/**
 * Retourne la partie `GraphCore` (= structure graphe + meta-header +
 * fondations symbolRefs/typedCalls) du snapshot. Phase 2 ADR-033 : extrait
 * les champs `GraphCore` depuis le fat blob via `loadSnapshotPayload`.
 *
 * Phase 4 (lointaine) verra le fat blob shrink jusqu'à ne plus contenir
 * que le graph core ; à ce moment ce loader deviendra réellement lazy
 * (= ne lira qu'une fraction du disque). L'API exposée maintenant
 * permet aux consumers de migrer progressivement (Phase 3) sans
 * attendre Phase 4.
 *
 * Retourne `null` si aucun snapshot n'est trouvé (cohérent avec
 * `loadSnapshotPayload`).
 */
export async function loadGraphCore(
  snapshotDir: string,
): Promise<GraphCore | null> {
  const payload = await loadSnapshotPayload(snapshotDir)
  if (!payload) return null
  return pickGraphCore(payload)
}

/**
 * Extrait les champs `GraphCore` d'un `GraphSnapshot` plein. Utility pure
 * — utile aux tests et aux consumers Phase 3 qui ont déjà chargé le
 * payload via une autre voie.
 */
export function pickGraphCore(payload: GraphSnapshot): GraphCore {
  // Préserve `undefined` pour les champs optionnels absents (vs
  // récrire en `null` ou `[]`, qui changerait la sémantique).
  return {
    version: payload.version,
    generatedAt: payload.generatedAt,
    commitHash: payload.commitHash,
    commitMessage: payload.commitMessage,
    rootDir: payload.rootDir,
    nodes: payload.nodes,
    edges: payload.edges,
    stats: payload.stats,
    symbolRefs: payload.symbolRefs,
    typedCalls: payload.typedCalls,
  }
}

/**
 * Retourne les facts d'un detector spécifique. Phase 2 ADR-033 :
 *  - priorise `.codegraph/snapshot.detectors/<name>.ndjson` (= v3, écrit
 *    en parallèle du fat blob depuis Phase 1)
 *  - fallback fat blob si le sub-file est absent (= snapshot v2 legacy
 *    OU detector pas exécuté lors du analyze)
 *
 * Retourne `undefined` si le champ n'a pas été calculé (cohérent avec la
 * shape `DetectorOutputs[K] | undefined`).
 *
 * Typage : `<K extends DetectorFieldName>` garantit que le nom est un
 * detector field valide à la compile ; le retour est typé sur la
 * propriété correspondante de `GraphSnapshot`.
 */
export async function loadDetectorOutput<K extends DetectorFieldName>(
  snapshotDir: string,
  fieldName: K,
): Promise<GraphSnapshot[K] | undefined> {
  const subPath = snapshotDetectorPath(snapshotDir, fieldName)
  try {
    const content = await fs.readFile(subPath, 'utf-8')
    return parseDetectorSubFile(fieldName, content) as GraphSnapshot[K]
  } catch {
    /* sub-file absent → fallback fat blob */
  }
  const payload = await loadSnapshotPayload(snapshotDir)
  return payload?.[fieldName]
}

/**
 * Parse un sub-file detector en fonction de son kind. Array → NDJSON
 * (1 fact / ligne). Bundle → 1 ligne JSON unique. Fichier vide →
 * `[]` pour kind=array, `undefined` pour kind=bundle (= sémantique
 * "detector n'a pas tourné").
 */
function parseDetectorSubFile(
  fieldName: DetectorFieldName,
  content: string,
): unknown {
  const kind = DETECTOR_FIELD_KINDS[fieldName]
  if (kind === 'array') {
    const lines = content.split('\n').filter((line) => line.length > 0)
    return lines.map((line) => JSON.parse(line))
  }
  // kind === 'bundle'
  const trimmed = content.trim()
  if (trimmed.length === 0) return undefined
  return JSON.parse(trimmed)
}

/**
 * Retourne les métriques cross-discipline du snapshot. Phase 2 ADR-033 :
 *  - priorise `.codegraph/snapshot.metrics.json` (= v3, écrit depuis
 *    Phase 1)
 *  - fallback fat blob si le sub-file est absent
 *
 * Retourne un `SnapshotMetrics` (potentiellement vide `{}` si aucune
 * métrique n'a été calculée) plutôt que `null`. Pas d'ambiguïté :
 * tous les champs sont optionnels par construction.
 */
export async function loadMetrics(
  snapshotDir: string,
): Promise<SnapshotMetrics> {
  const metricsPath = snapshotMetricsPath(snapshotDir)
  try {
    const content = await fs.readFile(metricsPath, 'utf-8')
    const trimmed = content.trim()
    if (trimmed.length === 0) return {}
    return JSON.parse(trimmed) as SnapshotMetrics
  } catch {
    /* sub-file absent → fallback fat blob */
  }
  const payload = await loadSnapshotPayload(snapshotDir)
  if (!payload) return {}
  return pickMetrics(payload)
}

/**
 * Extrait les champs `SnapshotMetrics` non-undefined d'un `GraphSnapshot`
 * plein. Utility pure — utilisé par le fallback fat blob et par les
 * tests de parité.
 */
export function pickMetrics(payload: GraphSnapshot): SnapshotMetrics {
  const out: Record<string, unknown> = {}
  for (const field of METRIC_FIELDS) {
    const value = payload[field]
    if (value !== undefined) {
      out[field] = value
    }
  }
  return out as SnapshotMetrics
}

/**
 * Re-export typé pour les consumers qui itèrent. Garantit que le nom passé
 * à `loadDetectorOutput` est typé. Utile e.g. pour
 * `for (const f of DETECTOR_FIELDS) loadDetectorOutput(dir, f)`.
 */
export type { DetectorFieldName } from './snapshot-fields.js'

// Note typage : `DetectorOutputs` exporté pour faciliter le typing des
// consumers Phase 3 ; ce module est désormais le seul à connaître le
// mapping detector → sub-file.
export type { DetectorOutputs }

/**
 * Validation de nom de fichier — empêche le path traversal côté
 * routes HTTP/dashboard. Accepte v2 canonique + legacy regex strict.
 */
export function isSafeSnapshotFilename(name: string): boolean {
  const base = path.basename(name)
  if (base === 'snapshot.json' || base === 'snapshot.json.bak') return true
  return /^snapshot-\d{4}-\d{2}-\d{2}T.*\.json$/.test(base)
}
