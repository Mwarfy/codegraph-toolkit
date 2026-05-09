// ADR-005
/**
 * Renderer markdown pour synopsis focusé sur un ou plusieurs fichiers.
 *
 * Différence avec `renderLevel{1,2,3}` (statiques, file-based, vue large) :
 * ce renderer produit une vue **dynamique** ranked par Personalized PageRank
 * autour d'un focus donné, dans un budget de tokens explicite.
 *
 * Cible d'usage : injection dans le contexte LLM en début de tour, ou
 * import dans CLAUDE.md / boot brief, ou retrieval ad-hoc d'un agent
 * via `codegraph synopsis --focus <file> --tokens 1500`.
 *
 * Format de sortie privilégie la densité — pas de fluff, pas de
 * répétition de noms de fichier dans des sections distinctes.
 */

import type { GraphSnapshot } from '../core/types.js'
import { rankFiles, type RankedFile } from './rank.js'

export interface FocusedSynopsisOptions {
  /** Focus files passed to PageRank (boost ×100). */
  focus: string[]
  /** Token budget approximatif (chars/4). Default 1500. */
  tokens?: number
  /** Recently-modified files (passé à rankFiles). */
  recentlyModified?: string[]
  /** Header optionnel custom (default = auto-généré avec date). */
  header?: string
}

const DEFAULT_TOKEN_BUDGET = 1500
const CHARS_PER_TOKEN = 4

interface NodeMeta {
  loc?: number
  exportNames: string[]
  importerCount: number
  cycles: number
  isHub: boolean
}

function basename(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? p : p.slice(i + 1)
}

function extractMeta(snapshot: GraphSnapshot, fileId: string): NodeMeta {
  const node = snapshot.nodes.find((n) => n.id === fileId)
  const importers = snapshot.edges.filter((e) => e.to === fileId && e.type === 'import')
  const cycles = (snapshot.cycles ?? []).filter((c) => {
    const files = (c as { files?: string[] }).files
    return Array.isArray(files) && files.includes(fileId)
  }).length
  const exportNames = (node?.exports ?? [])
    .filter((e) => !e.confidence || e.confidence !== 'safe-to-remove')
    .map((e) => e.name)
    .slice(0, 8)
  return {
    loc: node?.loc,
    exportNames,
    importerCount: importers.length,
    cycles,
    isHub: importers.length >= 20,
  }
}

function renderEntry(r: RankedFile, meta: NodeMeta, scoreNorm: number): string {
  const tags: string[] = []
  if (meta.isHub) tags.push('hub')
  if (meta.cycles > 0) tags.push(`${meta.cycles} cycle(s)`)
  const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : ''
  const locStr = meta.loc != null ? ` · ${meta.loc} LOC` : ''
  const reason = r.reasons.slice(0, 2).join(' · ') || 'structural'

  let entry = `### ${r.file}${tagStr}\n`
  entry += `score=${scoreNorm.toFixed(3)} · in=${meta.importerCount}${locStr} — ${reason}\n`
  if (meta.exportNames.length > 0) {
    entry += `exports: ${meta.exportNames.join(', ')}\n`
  }
  entry += '\n'
  return entry
}

/**
 * Produit un markdown synopsis focusé qui rentre dans le budget de tokens.
 *
 * Algorithme :
 *   1. rankFiles avec personalization sur le focus
 *   2. construire le header + bloc focus
 *   3. itérer top-ranked, ajouter chaque entrée tant que le budget tient
 *   4. émettre footer avec count "+N more files (truncated)"
 */
export function renderFocusedSynopsis(
  snapshot: GraphSnapshot,
  options: FocusedSynopsisOptions,
): string {
  const tokenBudget = options.tokens ?? DEFAULT_TOKEN_BUDGET
  const charBudget = tokenBudget * CHARS_PER_TOKEN

  const ranked = rankFiles(snapshot, {
    focus: options.focus,
    recentlyModified: options.recentlyModified,
  })
  if (ranked.length === 0) {
    return '# Focused synopsis\n\n_(empty snapshot — run `codegraph analyze` first)_\n'
  }

  // Normaliser scores au [0, 1] pour affichage lisible
  const maxScore = ranked[0]?.score ?? 1

  const lines: string[] = []
  const header = options.header ?? `# Synopsis — focus: ${options.focus.map(basename).join(', ')}`
  lines.push(header)
  lines.push('')
  lines.push(`> Personalized PageRank sur ${snapshot.nodes.filter((n) => n.type === 'file').length} files · token budget ${tokenBudget}`)
  lines.push('')

  // Bloc focus prominent
  if (options.focus.length > 0) {
    lines.push('## Focus')
    for (const f of options.focus) {
      const meta = extractMeta(snapshot, f)
      const locStr = meta.loc != null ? ` · ${meta.loc} LOC` : ''
      const hubTag = meta.isHub ? ' ⚠ hub' : ''
      lines.push(`- \`${f}\`${hubTag} (in=${meta.importerCount}${locStr})`)
    }
    lines.push('')
  }

  lines.push('## Top related (ranked)')
  lines.push('')

  // Construire les entrées en respectant le budget
  let charsUsed = lines.join('\n').length
  let shown = 0
  let truncated = 0
  const focusSet = new Set(options.focus)

  for (const r of ranked) {
    if (focusSet.has(r.file)) continue // déjà dans le bloc Focus
    const meta = extractMeta(snapshot, r.file)
    const scoreNorm = r.score / maxScore
    const entry = renderEntry(r, meta, scoreNorm)
    const after = charsUsed + entry.length

    // Réserve ~80 chars pour le footer "+N more files"
    if (after > charBudget - 80 && shown >= 5) {
      truncated = ranked.length - focusSet.size - shown
      break
    }
    lines.push(entry.trimEnd())
    lines.push('')
    charsUsed = after
    shown++
  }

  if (truncated > 0) {
    lines.push(`_(+${truncated} more files truncated by token budget)_`)
  }

  return lines.join('\n') + '\n'
}
