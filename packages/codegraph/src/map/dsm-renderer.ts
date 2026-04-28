/**
 * DSM ASCII renderer — phase 3.8 #4.
 *
 * Produit une matrice texte lisible pour MAP.md / CLI. Format :
 *   - colonnes et rangs numérotés (labels trop longs pour en-tête)
 *   - cellule `·` = diagonale, `•` = forward dep, `↑` = back-edge (cycle)
 *   - légende + liste des back-edges en dessous
 *   - liste des levels (SCCs en ordre topologique, marqués * quand taille ≥ 2)
 *
 * Lisibilité acceptable jusqu'à ~40 rangs. Au-delà, préférer la granularité
 * container ou le rendu SVG web.
 */

import type { DsmResult } from '../core/types.js'

export interface DsmRenderOptions {
  /** Titre optionnel rendu en première ligne. */
  title?: string
  /** Si true, inclut la légende et la liste des back-edges. Default true. */
  includeLegend?: boolean
}

export function renderDsm(dsm: DsmResult, options: DsmRenderOptions = {}): string {
  const { order, matrix, backEdges, levels } = dsm
  const N = order.length
  if (N === 0) return '_(empty DSM)_\n'

  const includeLegend = options.includeLegend ?? true
  const lines: string[] = []

  if (options.title) {
    lines.push(`### ${options.title}`)
    lines.push('')
  }

  // Largeur des index : nombre de chiffres.
  const idxWidth = Math.max(2, String(N).length)
  const cellWidth = idxWidth + 2  // espace-content-espace

  const pad = (s: string, w: number): string => {
    if (s.length >= w) return s.slice(0, w)
    const extra = w - s.length
    const left = Math.floor(extra / 2)
    const right = extra - left
    return ' '.repeat(left) + s + ' '.repeat(right)
  }

  // Header row : `     │  1 │  2 │ ...`
  const headerCells = order.map((_, i) => pad(String(i + 1), cellWidth))
  const rowLabelWidth = idxWidth + 2  // ex: " 1. "
  lines.push(' '.repeat(rowLabelWidth) + '│' + headerCells.join('│') + '│')

  // Separator : `─────┼────┼────┤`
  const sep = '─'.repeat(rowLabelWidth) + '┼' + order.map(() => '─'.repeat(cellWidth)).join('┼') + '┤'
  lines.push(sep)

  // Data rows
  for (let i = 0; i < N; i++) {
    const rowLabel = pad(String(i + 1) + '.', rowLabelWidth)
    const cells = matrix[i]!.map((v, j) => {
      if (i === j) return pad('·', cellWidth)
      if (v === 0) return pad('', cellWidth)
      return pad(i > j ? '↑' : '•', cellWidth)
    })
    lines.push(rowLabel + '│' + cells.join('│') + '│')
  }

  if (!includeLegend) return lines.join('\n') + '\n'

  lines.push('')
  lines.push('**Legend**')
  for (let i = 0; i < N; i++) {
    lines.push(`  ${i + 1}. \`${order[i]}\``)
  }

  lines.push('')
  lines.push('**Levels** (topological order)')
  levels.forEach((members, li) => {
    const marker = members.length >= 2 ? ' *cycle*' : ''
    const shortMembers = members
      .map((m) => order.indexOf(m) + 1)
      .sort((a, b) => a - b)
      .map((n) => String(n))
      .join(', ')
    lines.push(`  L${li + 1}: { ${shortMembers} }${marker}`)
  })

  if (backEdges.length > 0) {
    lines.push('')
    lines.push(`**Back-edges** (cycles, ${backEdges.length})`)
    for (const be of backEdges) {
      lines.push(`  ${be.fromIdx + 1} → ${be.toIdx + 1}  \`${be.from}\` → \`${be.to}\``)
    }
  }

  return lines.join('\n') + '\n'
}

/**
 * Aggrège les nodes au niveau « container » = `depth` premiers segments de
 * chemin (ex: depth=3 sur `sentinel-core/src/kernel/event-bus.ts` → `sentinel-core/src/kernel`).
 * Utile pour rendre un DSM lisible sur un repo de quelques centaines de fichiers.
 */
export function aggregateByContainer(
  nodes: string[],
  edges: Array<{ from: string; to: string }>,
  depth = 3,
): { nodes: string[]; edges: Array<{ from: string; to: string }> } {
  const containerOf = (id: string): string => {
    const parts = id.split('/').filter(Boolean)
    return parts.slice(0, Math.min(depth, parts.length)).join('/') || id
  }

  const containers = new Set<string>()
  for (const n of nodes) containers.add(containerOf(n))

  const aggEdges = new Set<string>()
  for (const e of edges) {
    const a = containerOf(e.from)
    const b = containerOf(e.to)
    if (a === b) continue  // ignore intra-container
    aggEdges.add(`${a}\0${b}`)
  }

  return {
    nodes: [...containers].sort(),
    edges: [...aggEdges].map((s) => {
      const [from, to] = s.split('\0')
      return { from: from!, to: to! }
    }),
  }
}
