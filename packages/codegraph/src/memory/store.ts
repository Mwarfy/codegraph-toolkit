// ADR-002
/**
 * Mémoire inter-sessions du codegraph-toolkit (Phase 4 axe 3).
 *
 * Stocke des entrées qui survivent aux sessions Claude Code dans
 * `~/.codegraph-toolkit/memory/<project-slug>.json` :
 *
 *   - **false-positive** : signal détecteur déclaré non-actionnable par
 *     le user (ex: "ce truth-point est un faux positif Drizzle"). Le hook
 *     PostToolUse skip les sections qui matchent.
 *   - **decision** : choix d'archi pris ad hoc qui n'a pas (encore) son
 *     ADR. Évite de re-poser la même question session après session.
 *   - **incident** : fingerprint d'un incident résolu. Aide à reconnaître
 *     un pattern qui a déjà mordu (et où la fix vit).
 *
 * Le store est PER-PROJET (slug = path absolu hashé). Pas de cross-projet
 * pour V1 — éviter le coupling entre projets différents.
 *
 * Concurrence : last-writer-wins (pas de fcntl lock V1). Si 2 sessions
 * écrivent en même temps, la dernière gagne. En pratique, les writes
 * sont rares (= mark explicit), pas un risque chaud.
 *
 * Privacy : le store local peut contenir des notes sensibles. La fonction
 * `recall()` retourne UNE PROJECTION SCOPÉE — jamais le dump complet.
 * `loadMemoryRaw()` (full dump) est exposé séparément pour le CLI.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import * as crypto from 'node:crypto'

// ─── Types publics ─────────────────────────────────────────────────────────

export type MemoryEntryKind = 'false-positive' | 'decision' | 'incident'

export interface MemoryEntryScope {
  /** Fichier concerné (relatif au rootDir). Optionnel. */
  file?: string
  /** Detector concerné (truth-points, cycles, …). Optionnel. */
  detector?: string
  /** Tags libres pour filtrage adhoc. */
  tags?: string[]
}

export interface MemoryEntry {
  /** ID stable basé sur kind + fingerprint. Sert au mark/unmark. */
  id: string
  kind: MemoryEntryKind
  /** Identifiant logique de l'entrée. Usage typique :
   *    - false-positive : `<detector>:<file>:<sub-target>`
   *    - decision       : `<topic-slug>`
   *    - incident       : `<area>:<symptom>:<date>`
   *  Le combo (kind, fingerprint) est unique. */
  fingerprint: string
  /** Raison humaine (1-3 phrases). Affiché tel quel dans les recalls. */
  reason: string
  scope?: MemoryEntryScope
  /** ISO date. */
  addedAt: string
  /** ISO date si l'entrée a été marquée obsolète. null sinon. */
  obsoleteAt: string | null
}

export interface MemoryStore {
  version: 1
  /** Nom human-readable du projet (basename du rootDir). Aide au debug. */
  project: string
  /** Path absolu du rootDir (utile pour vérifier qu'on lit le bon store). */
  rootDir: string
  /** Date de la dernière modification. */
  lastUpdated: string
  entries: MemoryEntry[]
}

export interface RecallScope {
  kind?: MemoryEntryKind
  file?: string
  detector?: string
  /** Inclure les entrées marquées obsolètes ? Default false. */
  includeObsolete?: boolean
}

// ─── Path resolution ───────────────────────────────────────────────────────

/**
 * Slug stable : `<basename>-<sha256(absPath).slice(0,8)>.json`. Le basename
 * sert à la lisibilité humaine quand on liste `~/.codegraph-toolkit/memory/`.
 * Le hash garantit l'unicité et la stabilité même si 2 projets ont le même
 * basename. Si le projet est déplacé, le hash change → nouvelle mémoire
 * vide (acceptable v1, cf. plan).
 */
export function memoryPathFor(rootDir: string): string {
  const abs = path.resolve(rootDir)
  const basename = path.basename(abs).replace(/[^A-Za-z0-9_-]/g, '_') || 'root'
  const hash = crypto.createHash('sha256').update(abs).digest('hex').slice(0, 8)
  return path.join(memoryDir(), `${basename}-${hash}.json`)
}

export function memoryDir(): string {
  return path.join(os.homedir(), '.codegraph-toolkit', 'memory')
}

// ─── Load / Save ───────────────────────────────────────────────────────────

/**
 * Charge le store. Si le fichier n'existe pas → retourne un store vide
 * neuf (pas écrit sur disque). Si le fichier est corrompu → throw.
 */
export async function loadMemoryRaw(rootDir: string): Promise<MemoryStore> {
  const file = memoryPathFor(rootDir)
  try {
    const content = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(content)
    return validateStore(parsed, rootDir)
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return emptyStore(rootDir)
    }
    throw err
  }
}

async function saveStore(store: MemoryStore): Promise<void> {
  const file = memoryPathFor(store.rootDir)
  await fs.mkdir(path.dirname(file), { recursive: true })
  store.lastUpdated = new Date().toISOString()
  await fs.writeFile(file, JSON.stringify(store, null, 2) + '\n')
}

function emptyStore(rootDir: string): MemoryStore {
  return {
    version: 1,
    project: path.basename(path.resolve(rootDir)),
    rootDir: path.resolve(rootDir),
    lastUpdated: new Date().toISOString(),
    entries: [],
  }
}

function validateStore(raw: any, rootDir: string): MemoryStore {
  validateStoreShape(raw)
  return {
    version: 1,
    project: typeof raw.project === 'string' ? raw.project : path.basename(path.resolve(rootDir)),
    rootDir: typeof raw.rootDir === 'string' ? raw.rootDir : path.resolve(rootDir),
    lastUpdated: typeof raw.lastUpdated === 'string' ? raw.lastUpdated : new Date().toISOString(),
    entries: validateEntries(raw.entries),
  }
}

function validateStoreShape(raw: any): void {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('memory store: not an object')
  }
  if (raw.version !== 1) {
    throw new Error(`memory store: unsupported version ${raw.version}`)
  }
  if (!Array.isArray(raw.entries)) {
    throw new Error('memory store: entries is not an array')
  }
}

/** Soft-validate : ignore corrupted entries plutôt que tout perdre. */
function validateEntries(rawEntries: unknown[]): MemoryEntry[] {
  const valid: MemoryEntry[] = []
  for (const e of rawEntries) {
    const entry = validateOneEntry(e)
    if (entry) valid.push(entry)
  }
  return valid
}

function validateOneEntry(e: unknown): MemoryEntry | null {
  if (!e || typeof e !== 'object') return null
  const r = e as any
  if (typeof r.id !== 'string' || typeof r.kind !== 'string') return null
  if (typeof r.fingerprint !== 'string' || typeof r.reason !== 'string') return null
  if (typeof r.addedAt !== 'string') return null
  if (r.obsoleteAt !== null && typeof r.obsoleteAt !== 'string') return null
  if (!isValidKind(r.kind)) return null
  return {
    id: r.id,
    kind: r.kind,
    fingerprint: r.fingerprint,
    reason: r.reason,
    scope: r.scope && typeof r.scope === 'object' ? r.scope : undefined,
    addedAt: r.addedAt,
    obsoleteAt: r.obsoleteAt ?? null,
  }
}

function isValidKind(k: string): k is MemoryEntryKind {
  return k === 'false-positive' || k === 'decision' || k === 'incident'
}

// ─── Add / Mark obsolete ───────────────────────────────────────────────────

/**
 * Construit l'ID stable d'une entrée à partir de (kind, fingerprint).
 * Identique pour les mêmes inputs → permet l'idempotence du `addEntry`.
 */
export function entryId(kind: MemoryEntryKind, fingerprint: string): string {
  // SHA-1 collision resistance non requise — on tronque a 12 hex chars (memoization key).
  // crypto-ok: content-addressable ID, not security-critical
  return crypto.createHash('sha1').update(`${kind}:${fingerprint}`).digest('hex').slice(0, 12)
}

export interface AddEntryArgs {
  kind: MemoryEntryKind
  fingerprint: string
  reason: string
  scope?: MemoryEntryScope
}

/**
 * Ajoute (ou met à jour) une entrée. Si une entrée avec le même
 * (kind, fingerprint) existe déjà : update reason/scope et resurrect si
 * elle était obsolète. Idempotent — appel répété = no-op si rien change.
 */
export async function addEntry(rootDir: string, args: AddEntryArgs): Promise<MemoryEntry> {
  const store = await loadMemoryRaw(rootDir)
  const id = entryId(args.kind, args.fingerprint)
  const existing = store.entries.find((e) => e.id === id)
  let entry: MemoryEntry
  if (existing) {
    existing.reason = args.reason
    if (args.scope !== undefined) existing.scope = args.scope
    existing.obsoleteAt = null      // resurrect si obsolète
    entry = existing
  } else {
    entry = {
      id,
      kind: args.kind,
      fingerprint: args.fingerprint,
      reason: args.reason,
      scope: args.scope,
      addedAt: new Date().toISOString(),
      obsoleteAt: null,
    }
    store.entries.push(entry)
  }
  await saveStore(store)
  return entry
}

/**
 * Marque une entrée obsolète. Préserve l'historique (pour audit) plutôt
 * que de delete dur. Le `recall()` skip les obsolètes par défaut.
 */
export async function markObsolete(rootDir: string, id: string): Promise<boolean> {
  const store = await loadMemoryRaw(rootDir)
  const entry = store.entries.find((e) => e.id === id)
  if (!entry) return false
  entry.obsoleteAt = new Date().toISOString()
  await saveStore(store)
  return true
}

/**
 * Supprime DUREMENT une entrée (vs markObsolete qui garde l'historique).
 * À utiliser avec prudence — perd l'audit trail.
 */
export async function deleteEntry(rootDir: string, id: string): Promise<boolean> {
  const store = await loadMemoryRaw(rootDir)
  const before = store.entries.length
  store.entries = store.entries.filter((e) => e.id !== id)
  if (store.entries.length === before) return false
  await saveStore(store)
  return true
}

// ─── Recall (projection scopée) ────────────────────────────────────────────

/**
 * Retourne les entrées qui matchent le scope. Skip les obsolètes par
 * défaut (override via `includeObsolete: true`).
 *
 * Matching :
 *   - kind     : exact si fourni
 *   - file     : matche si l'entry.scope.file == file (exact)
 *   - detector : matche si l'entry.scope.detector == detector (exact)
 *
 * Si aucun scope : retourne toutes les entrées non-obsolètes (mais
 * l'appelant doit être conscient que c'est potentiellement sensible —
 * préférer un scope explicit).
 */
export async function recall(rootDir: string, scope: RecallScope = {}): Promise<MemoryEntry[]> {
  const store = await loadMemoryRaw(rootDir)
  return store.entries.filter((e) => {
    if (!scope.includeObsolete && e.obsoleteAt !== null) return false
    if (scope.kind && e.kind !== scope.kind) return false
    if (scope.file && e.scope?.file !== scope.file) return false
    if (scope.detector && e.scope?.detector !== scope.detector) return false
    return true
  })
}
