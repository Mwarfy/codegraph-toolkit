/**
 * codegraph_who_imports(path) — liste tous les fichiers qui importent
 * le fichier donné. Reverse direction du graph d'imports.
 *
 * Différent de lsp_find_references : LSP suit les SYMBOLES (qui appelle
 * cette fonction). Ce tool suit les FICHIERS (qui import ce module).
 * Complémentaire — LSP zoom symbol-level, codegraph zoom file-level.
 */

import { loadSnapshot, toRelPath } from '../snapshot-loader.js'

export interface WhoImportsArgs {
  file_path: string
  repo_root?: string
  /** Inclure aussi les edges 'event', 'queue', etc. ? Default false (imports only). */
  include_indirect?: boolean
}

export function codegraphWhoImports(args: WhoImportsArgs): { content: string } {
  const repoRoot = args.repo_root ?? process.cwd()
  const snapshot = loadSnapshot(repoRoot)
  const relPath = toRelPath(repoRoot, args.file_path)

  const edges = snapshot.edges ?? []
  const filterFn = args.include_indirect
    ? (e: any) => e.to === relPath
    : (e: any) => e.to === relPath && e.type === 'import'

  const matching = edges.filter(filterFn)

  if (matching.length === 0) {
    return { content: `No file imports ${relPath} (in the codegraph snapshot).` }
  }

  // Group by edge type
  const byType = new Map<string, Array<{ from: string; label?: string }>>()
  for (const e of matching) {
    if (!byType.has(e.type)) byType.set(e.type, [])
    byType.get(e.type)!.push({ from: e.from, label: e.label })
  }

  const lines: string[] = []
  lines.push(`📍 ${matching.length} file(s) depend on ${relPath}:`)

  for (const [type, items] of byType) {
    lines.push(`\n## ${type} (${items.length})`)
    for (const it of items.slice(0, 50)) {
      const label = it.label ? ` [${it.label}]` : ''
      lines.push(`  - ${it.from}${label}`)
    }
    if (items.length > 50) {
      lines.push(`  ... +${items.length - 50} more`)
    }
  }

  return { content: lines.join('\n') }
}
