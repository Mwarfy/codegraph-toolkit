// ADR-027
/**
 * Content-addressed fact store — Phase 3 d'ADR-027.
 *
 * Chaque fact AST émis par le visitor (cf. ADR-026) reçoit un `fact_id`
 * stable :
 *
 *   fact_id = sha256(relation_name + '\x00' + canonicalJson(values))
 *
 * Deux facts strictement identiques (même relation, mêmes valeurs) ont
 * le même fact_id — dédup natural, à la Glean/Unison.
 *
 * Stockage (3 fichiers dans `.codegraph/`) :
 *   - `facts.store.ndjson` — append-only, un fact JSON par ligne.
 *     Sert d'entrepôt content-addressed cumulatif (dédupliqué).
 *   - `facts.head.json` — snapshot HEAD = set des fact_ids actifs +
 *     groupement par relation + factSetHash global.
 *   - `facts.bases/<sha>.json` — cache des HEAD historiques utilisé par
 *     le mode PR (cf. pr-mode.ts).
 *
 * Contrats :
 *   - Le store reste append-only (jamais de delete). Compaction = ADR séparée.
 *   - L'AstFactsBundle source n'est jamais modifié — le store est dérivé.
 *   - L'ordre est INSENSIBLE aux runs : tri lex par fact_id avant
 *     factSetHash, tri lex par fact_id dans byRelation. Garantit le
 *     déterminisme cross-run même si `project.getSourceFiles()` change
 *     l'ordre de discovery.
 *   - Aucune dépendance Salsa ajoutée (cf. ADR-007) : la matérialisation
 *     est un post-process du `AstFactsBundle` agrégé.
 */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { AstFactsBundle } from '../datalog-detectors/ast-facts/types.js'

export const FACT_STORE_VERSION = 1

const STORE_FILE = 'facts.store.ndjson'
const HEAD_FILE = 'facts.head.json'
const BASES_DIR = 'facts.bases'

export interface FactRecord {
  /** Content-addressed identifier (sha256 hex, 64 chars). */
  id: string
  /** Relation name (key in AstFactsBundle, e.g. "numericLiterals"). */
  r: string
  /** Tuple values — canonicalised before hashing. */
  v: Record<string, unknown>
}

export interface FactsHead {
  version: number
  factSetHash: string
  generatedAt: string
  /** baseSha optionnel pour info — non-authoritative. */
  baseSha?: string
  /** Par relation : liste triée des fact_ids actifs. */
  byRelation: Record<string, string[]>
}

export function factStorePath(snapshotDir: string): string {
  return path.join(snapshotDir, STORE_FILE)
}

export function factsHeadPath(snapshotDir: string): string {
  return path.join(snapshotDir, HEAD_FILE)
}

export function basesDir(snapshotDir: string): string {
  return path.join(snapshotDir, BASES_DIR)
}

export function basePath(snapshotDir: string, sha: string): string {
  return path.join(basesDir(snapshotDir), `${sha}.json`)
}

/**
 * Sérialise `values` en JSON canonique : keys d'objets triées
 * récursivement. Garantit qu'un même contenu produit toujours la même
 * string, donc le même hash. Les arrays préservent leur ordre — c'est
 * sémantique pour beaucoup de facts (ex : args d'un call).
 */
export function canonicalJson(values: unknown): string {
  return JSON.stringify(values, (_key, v) => {
    if (v === null || v === undefined) return v
    if (typeof v !== 'object') return v
    if (Array.isArray(v)) return v
    const sorted: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      sorted[k] = (v as Record<string, unknown>)[k]
    }
    return sorted
  })
}

/**
 * Calcule le fact_id pour un tuple. Stable cross-runs et cross-process
 * tant que `relation` + `values` sont identiques (modulo l'ordre des
 * keys, normalisé par canonicalJson).
 */
export function computeFactId(relation: string, values: unknown): string {
  const canonical = relation + '\x00' + canonicalJson(values)
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * Matérialise un FactsHead depuis un AstFactsBundle. Pure : pas d'I/O,
 * pas de mutation du bundle. Le caller persistera via `writeFactStore`.
 */
export function buildFactsHead(
  bundle: AstFactsBundle,
  meta: { generatedAt: string; baseSha?: string },
): { head: FactsHead; records: FactRecord[] } {
  const byRelation: Record<string, string[]> = {}
  const records: FactRecord[] = []
  // Dédup par fact_id à la matérialisation — deux tuples strictement
  // identiques au sein de la même relation ne produisent qu'un record.
  const seen = new Set<string>()

  const bundleAsRecord = bundle as unknown as Record<string, unknown[]>
  for (const relation of Object.keys(bundleAsRecord).sort()) {
    const tuples = bundleAsRecord[relation]
    if (!Array.isArray(tuples)) continue
    const ids: string[] = []
    for (const tuple of tuples) {
      const id = computeFactId(relation, tuple)
      if (!seen.has(id)) {
        seen.add(id)
        records.push({ id, r: relation, v: tuple as Record<string, unknown> })
        ids.push(id)
      }
    }
    ids.sort()
    byRelation[relation] = ids
  }

  // factSetHash = hash de la concaténation lex-triée des fact_ids.
  // Insensible à l'ordre d'apparition dans le bundle.
  const allIds: string[] = []
  for (const ids of Object.values(byRelation)) allIds.push(...ids)
  allIds.sort()
  const factSetHash = createHash('sha256').update(allIds.join('\n')).digest('hex')

  // Tri lex des records pour écriture déterministe du store NDJSON
  // (le store dédupera de toute façon, mais préserver l'ordre déterministe
  // facilite les diffs git si on inspecte manuellement).
  records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const head: FactsHead = {
    version: FACT_STORE_VERSION,
    factSetHash,
    generatedAt: meta.generatedAt,
    baseSha: meta.baseSha,
    byRelation,
  }
  return { head, records }
}

/**
 * Persiste store + head atomiquement. Append-only : les records pas
 * encore dans le store sont ajoutés ; les existants sont skip (dédup
 * par id). Le head est réécrit complet (atomic via tmp+rename).
 *
 * O(N + M) où N = facts existants dans le store, M = nouveaux facts.
 * Pour 100k facts × 200 bytes = ~20 MB, lecture/écriture < 200ms typique.
 */
export async function writeFactStore(
  snapshotDir: string,
  head: FactsHead,
  records: FactRecord[],
): Promise<{ added: number; existing: number }> {
  await fs.mkdir(snapshotDir, { recursive: true })

  const storeFile = factStorePath(snapshotDir)
  const existingIds = await loadExistingIds(storeFile)
  const newRecords = records.filter((r) => !existingIds.has(r.id))

  if (newRecords.length > 0) {
    // Append simple — pas de réécriture du store. La présence d'un id dans
    // le store est garantie une fois pour toutes (immuabilité).
    const lines = newRecords.map((r) => JSON.stringify(r)).join('\n') + '\n'
    await fs.appendFile(storeFile, lines, 'utf-8')
  }

  // Head : tmp + rename atomique (le sidecar P2 + ce head sont les seuls
  // pointeurs au monde réel ; doivent rester cohérents).
  const headFile = factsHeadPath(snapshotDir)
  const tmp = headFile + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(head, null, 2), 'utf-8')
  await fs.rename(tmp, headFile)

  return { added: newRecords.length, existing: records.length - newRecords.length }
}

/**
 * Charge l'ensemble des fact_ids présents dans le store (pour dédup
 * append-only). Retourne un Set vide si le store n'existe pas encore.
 */
async function loadExistingIds(storeFile: string): Promise<Set<string>> {
  const ids = new Set<string>()
  let content: string
  try {
    content = await fs.readFile(storeFile, 'utf-8')
  } catch {
    return ids
  }
  for (const line of content.split('\n')) {
    if (!line) continue
    try {
      const parsed = JSON.parse(line) as { id?: string }
      if (typeof parsed.id === 'string') ids.add(parsed.id)
    } catch {
      // ligne corrompue (writeFactStore atomic via append — un seul
      // process actif normalement). Best-effort recovery : skip.
    }
  }
  return ids
}

/**
 * Lit le head courant (= snapshot des fact_ids actifs au HEAD).
 * Retourne null si absent ou invalide.
 */
export async function readFactsHead(snapshotDir: string): Promise<FactsHead | null> {
  let raw: string
  try {
    raw = await fs.readFile(factsHeadPath(snapshotDir), 'utf-8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as FactsHead
    if (
      !parsed ||
      parsed.version !== FACT_STORE_VERSION ||
      typeof parsed.factSetHash !== 'string' ||
      !parsed.byRelation
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

/**
 * Délta entre deux heads : `added` = facts dans `to` mais pas dans `from`,
 * `removed` = facts dans `from` mais pas dans `to`. Pure, déterministe.
 */
export interface FactsDelta {
  baseSha: string | undefined
  headSha: string | undefined
  baseFactSetHash: string
  headFactSetHash: string
  added: { id: string; relation: string }[]
  removed: { id: string; relation: string }[]
}

export function computeDelta(from: FactsHead, to: FactsHead): FactsDelta {
  const fromIds = collectIdsByRelation(from)
  const toIds = collectIdsByRelation(to)

  const added: { id: string; relation: string }[] = []
  const removed: { id: string; relation: string }[] = []

  for (const [id, relation] of toIds) {
    if (!fromIds.has(id)) added.push({ id, relation })
  }
  for (const [id, relation] of fromIds) {
    if (!toIds.has(id)) removed.push({ id, relation })
  }

  // Tri lex stable pour déterminisme.
  added.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  removed.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  return {
    baseSha: from.baseSha,
    headSha: to.baseSha,
    baseFactSetHash: from.factSetHash,
    headFactSetHash: to.factSetHash,
    added,
    removed,
  }
}

function collectIdsByRelation(head: FactsHead): Map<string, string> {
  const out = new Map<string, string>()
  for (const [relation, ids] of Object.entries(head.byRelation)) {
    for (const id of ids) out.set(id, relation)
  }
  return out
}

/**
 * Cache un FactsHead comme base pour le mode PR (cf. pr-mode.ts).
 * Le caller (analyze --pr) check `basePath(dir, baseSha)` avant de
 * relancer un analyze sur un ref.
 */
export async function saveBase(
  snapshotDir: string,
  baseSha: string,
  head: FactsHead,
): Promise<void> {
  await fs.mkdir(basesDir(snapshotDir), { recursive: true })
  const file = basePath(snapshotDir, baseSha)
  const tmp = file + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(head, null, 2), 'utf-8')
  await fs.rename(tmp, file)
}

/** Lit un FactsHead cache pour un ref donné, null si absent. */
export async function loadBase(
  snapshotDir: string,
  baseSha: string,
): Promise<FactsHead | null> {
  let raw: string
  try {
    raw = await fs.readFile(basePath(snapshotDir, baseSha), 'utf-8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as FactsHead
    if (parsed.version !== FACT_STORE_VERSION) return null
    return parsed
  } catch {
    return null
  }
}
