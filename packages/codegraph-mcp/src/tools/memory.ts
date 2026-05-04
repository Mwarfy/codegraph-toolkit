/**
 * codegraph_memory_recall + codegraph_memory_mark — mémoire inter-sessions
 * (Phase 4 axe 3).
 *
 * Recall = lecture scopée du store. Le tool ne dump JAMAIS le full store
 * dans la response (privacy) — il filtre côté serveur et retourne une
 * projection.
 *
 * Mark = ajout/update d'une entrée (false-positive, decision, incident).
 * Idempotent : même (kind, fingerprint) update au lieu de doublonner.
 */

import {
  recall, addEntry, markObsolete,
  type MemoryEntryKind,
} from '@liby-tools/codegraph'

// ─── recall ───────────────────────────────────────────────────────────────

export interface MemoryRecallArgs {
  repo_root?: string
  /** Filtrer par type d'entrée. */
  kind?: MemoryEntryKind
  /** Filtrer par fichier (scope.file exact match). */
  file?: string
  /** Filtrer par detector (scope.detector exact match). */
  detector?: string
  /** Inclure les entrées marquées obsolètes ? Default false. */
  include_obsolete?: boolean
}

export async function codegraphMemoryRecall(
  args: MemoryRecallArgs,
): Promise<{ content: string }> {
  const repoRoot = args.repo_root ?? process.cwd()
  const entries = await recall(repoRoot, {
    kind: args.kind,
    file: args.file,
    detector: args.detector,
    includeObsolete: args.include_obsolete,
  })

  const lines: string[] = []
  lines.push(`🧠 Memory recall — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`)
  appendScopeLine(args, lines)
  lines.push('')

  if (entries.length === 0) {
    lines.push('  (no entries match this scope — no prior memory to apply)')
    return { content: lines.join('\n') }
  }

  for (const e of entries) {
    appendEntryBlock(e, lines)
  }

  return { content: lines.join('\n') }
}

/** Récap du scope appliqué pour que l'agent comprenne le filtrage. */
function appendScopeLine(args: MemoryRecallArgs, lines: string[]): void {
  const scopeBits: string[] = []
  if (args.kind) scopeBits.push(`kind=${args.kind}`)
  if (args.file) scopeBits.push(`file=${args.file}`)
  if (args.detector) scopeBits.push(`detector=${args.detector}`)
  if (args.include_obsolete) scopeBits.push('include_obsolete=true')
  if (scopeBits.length > 0) lines.push(`  Scope: ${scopeBits.join(', ')}`)
}

interface MemEntryLike {
  kind: string
  fingerprint: string
  obsoleteAt?: string | null
  reason: string
  scope?: { file?: string; detector?: string; tags?: string[] }
  id: string
  addedAt: string
}

function appendEntryBlock(e: MemEntryLike, lines: string[]): void {
  const obsoleteTag = e.obsoleteAt ? ' [OBSOLETE]' : ''
  lines.push(`  • [${e.kind}] ${e.fingerprint}${obsoleteTag}`)
  lines.push(`    ${e.reason}`)
  appendEntryScope(e.scope, lines)
  lines.push(`    id: ${e.id}  ·  added: ${e.addedAt.slice(0, 10)}`)
  lines.push('')
}

function appendEntryScope(
  scope: MemEntryLike['scope'],
  lines: string[],
): void {
  if (!scope) return
  const bits: string[] = []
  if (scope.file) bits.push(`file=${scope.file}`)
  if (scope.detector) bits.push(`detector=${scope.detector}`)
  if (scope.tags && scope.tags.length > 0) bits.push(`tags=${scope.tags.join(',')}`)
  if (bits.length > 0) lines.push(`    scope: ${bits.join(', ')}`)
}

// ─── mark ─────────────────────────────────────────────────────────────────

export interface MemoryMarkArgs {
  repo_root?: string
  /** Type d'entrée à créer. */
  kind: MemoryEntryKind
  /** Identifiant unique de l'entrée (cf. doc store.MemoryEntry.fingerprint). */
  fingerprint: string
  /** Pourquoi cette entrée existe (1-3 phrases). */
  reason: string
  /** Scope optionnel (file, detector, tags). */
  scope_file?: string
  scope_detector?: string
  scope_tags?: string[]
  /**
   * Si true, marque l'entrée comme obsolète au lieu de l'ajouter. Cherche
   * par (kind, fingerprint) — pas par id (l'agent ne tape pas un hash).
   */
  obsolete?: boolean
}

export async function codegraphMemoryMark(
  args: MemoryMarkArgs,
): Promise<{ content: string }> {
  const repoRoot = args.repo_root ?? process.cwd()

  if (args.obsolete) {
    // Mark obsolete via (kind, fingerprint) → id stable, on peut le retrouver.
    const { entryId } = await import('@liby-tools/codegraph')
    const id = entryId(args.kind, args.fingerprint)
    const ok = await markObsolete(repoRoot, id)
    if (!ok) {
      return {
        content:
          `❌ No entry found for (kind=${args.kind}, fingerprint=${args.fingerprint}). ` +
          `Use codegraph_memory_recall to list current entries.`,
      }
    }
    return {
      content:
        `🧠 Memory mark — entry obsoleted\n` +
        `  kind: ${args.kind}\n` +
        `  fingerprint: ${args.fingerprint}\n` +
        `  Future recalls will skip it (use include_obsolete=true to see).`,
    }
  }

  const scope = (args.scope_file || args.scope_detector || args.scope_tags)
    ? {
        file: args.scope_file,
        detector: args.scope_detector,
        tags: args.scope_tags,
      }
    : undefined

  const entry = await addEntry(repoRoot, {
    kind: args.kind,
    fingerprint: args.fingerprint,
    reason: args.reason,
    scope,
  })

  return {
    content:
      `🧠 Memory mark — entry saved\n` +
      `  kind: ${entry.kind}\n` +
      `  fingerprint: ${entry.fingerprint}\n` +
      `  id: ${entry.id}\n` +
      `  reason: ${entry.reason}\n` +
      `  added: ${entry.addedAt.slice(0, 10)}`,
  }
}
