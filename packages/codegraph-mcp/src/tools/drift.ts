/**
 * codegraph_drift(file?) — drift signals (Phase 4 axe 4).
 *
 * Liste les patterns "drift agentique" détectés : excès de params
 * optionnels, wrappers superflus, TODO sans owner. Sert à RALENTIR
 * l'agent au bon moment, pas à bloquer.
 *
 * - Sans `file` : retourne tous les signaux du projet, groupés par kind.
 * - Avec `file` : retourne les signaux UNIQUEMENT pour ce fichier.
 *
 * Le hook PostToolUse affiche déjà les signaux du fichier qu'on vient
 * d'éditer dans une section dédiée. Ce tool sert au pull on-demand
 * (audit large d'un module, audit global avant refactor).
 */

import * as path from 'node:path'
import { loadSnapshot, toRelPath } from '../snapshot-loader.js'

interface DriftSignal {
  kind: 'excessive-optional-params' | 'wrapper-superfluous' | 'todo-no-owner'
  file: string
  line: number
  message: string
  severity: 1 | 2 | 3
  details?: Record<string, string | number | boolean>
}

export interface DriftArgs {
  /** Optionnel. Si fourni : filtre sur ce fichier. */
  file_path?: string
  repo_root?: string
  /** Limite top-N par kind (default 10). Au-delà : "+N more" résumé. */
  limit?: number
}

const DEFAULT_LIMIT = 10

export function codegraphDrift(args: DriftArgs): { content: string } {
  const repoRoot = args.repo_root ?? process.cwd()
  const limit = args.limit ?? DEFAULT_LIMIT
  const snapshot = loadSnapshot(repoRoot)
  const all: DriftSignal[] = snapshot.driftSignals ?? []

  const { scope, scopeLabel } = filterByScope(all, repoRoot, args.file_path)

  if (scope.length === 0) {
    return { content: emptyScopeMessage(scopeLabel, !!args.file_path) }
  }

  return { content: formatDriftSignalsByKind(scope, scopeLabel, limit) }
}

function filterByScope(
  all: DriftSignal[],
  repoRoot: string,
  filePath: string | undefined,
): { scope: DriftSignal[]; scopeLabel: string } {
  if (!filePath) return { scope: all, scopeLabel: 'project-wide' }
  const rel = toRelPath(repoRoot, filePath)
  return {
    scope: all.filter((s) => s.file === rel),
    scopeLabel: `for ${rel}`,
  }
}

function emptyScopeMessage(scopeLabel: string, perFile: boolean): string {
  const lines: string[] = []
  lines.push(`🐌 Drift signals — 0 total ${scopeLabel}`)
  lines.push('')
  lines.push(perFile
    ? '  ✓ No drift signals for this file.'
    : '  ✓ No drift signals — project clean.',
  )
  return lines.join('\n')
}

const KIND_ORDER: Array<DriftSignal['kind']> = [
  'excessive-optional-params',
  'wrapper-superfluous',
  'todo-no-owner',
]

function formatDriftSignalsByKind(
  scope: DriftSignal[],
  scopeLabel: string,
  limit: number,
): string {
  const lines: string[] = []
  lines.push(`🐌 Drift signals — ${scope.length} total ${scopeLabel}`)
  lines.push('')

  const byKind = groupByKind(scope)
  for (const kind of KIND_ORDER) {
    const items = byKind.get(kind)
    if (!items || items.length === 0) continue
    items.sort(compareDriftSignal)
    appendKindSection(kind, items, limit, lines)
  }

  lines.push('  💡 Convention : `// drift-ok: <reason>` sur la ligne précédant un signal le supprime.')
  return lines.join('\n')
}

function groupByKind(scope: DriftSignal[]): Map<string, DriftSignal[]> {
  const byKind = new Map<string, DriftSignal[]>()
  for (const s of scope) {
    if (!byKind.has(s.kind)) byKind.set(s.kind, [])
    byKind.get(s.kind)!.push(s)
  }
  return byKind
}

/** Severity desc, file asc, line asc. */
function compareDriftSignal(a: DriftSignal, b: DriftSignal): number {
  if (a.severity !== b.severity) return b.severity - a.severity
  if (a.file !== b.file) return a.file < b.file ? -1 : 1
  return a.line - b.line
}

function appendKindSection(
  kind: string,
  items: DriftSignal[],
  limit: number,
  lines: string[],
): void {
  lines.push(`  ## ${kind} (${items.length})`)
  for (const s of items.slice(0, limit)) {
    const sevTag = s.severity === 3 ? '⚠⚠ ' : s.severity === 2 ? '⚠ ' : ''
    lines.push(`    ${sevTag}${s.file}:${s.line}`)
    lines.push(`      ${s.message}`)
  }
  if (items.length > limit) {
    lines.push(`    (+${items.length - limit} more — pass limit higher to see)`)
  }
  lines.push('')
}
