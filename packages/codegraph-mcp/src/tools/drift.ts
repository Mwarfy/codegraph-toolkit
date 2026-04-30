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

  let scope: DriftSignal[]
  let scopeLabel: string
  if (args.file_path) {
    const rel = toRelPath(repoRoot, args.file_path)
    scope = all.filter((s) => s.file === rel)
    scopeLabel = `for ${rel}`
  } else {
    scope = all
    scopeLabel = 'project-wide'
  }

  const lines: string[] = []
  lines.push(`🐌 Drift signals — ${scope.length} total ${scopeLabel}`)
  lines.push('')

  if (scope.length === 0) {
    if (args.file_path) {
      lines.push('  ✓ No drift signals for this file.')
    } else {
      lines.push('  ✓ No drift signals — project clean.')
    }
    return { content: lines.join('\n') }
  }

  // Grouper par kind. Pour chaque kind, top-N triés par severity puis file.
  const byKind = new Map<string, DriftSignal[]>()
  for (const s of scope) {
    if (!byKind.has(s.kind)) byKind.set(s.kind, [])
    byKind.get(s.kind)!.push(s)
  }

  const kindOrder = ['excessive-optional-params', 'wrapper-superfluous', 'todo-no-owner']
  for (const kind of kindOrder) {
    const items = byKind.get(kind)
    if (!items || items.length === 0) continue
    items.sort((a, b) => b.severity - a.severity || (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line))
    lines.push(`  ## ${kind} (${items.length})`)
    const shown = items.slice(0, limit)
    for (const s of shown) {
      const sevTag = s.severity === 3 ? '⚠⚠ ' : s.severity === 2 ? '⚠ ' : ''
      lines.push(`    ${sevTag}${s.file}:${s.line}`)
      lines.push(`      ${s.message}`)
    }
    if (items.length > limit) {
      lines.push(`    (+${items.length - limit} more — pass limit higher to see)`)
    }
    lines.push('')
  }

  lines.push('  💡 Convention : `// drift-ok: <reason>` sur la ligne précédant un signal le supprime.')

  return { content: lines.join('\n') }
}
