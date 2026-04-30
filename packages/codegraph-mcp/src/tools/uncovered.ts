/**
 * codegraph_uncovered() — liste les fichiers source sans test associé,
 * filtré par criticité (hubs / truth-point writers en priorité).
 */

import { loadSnapshot } from '../snapshot-loader.js'

export interface UncoveredArgs {
  repo_root?: string
  /** Limit results. Default 30. */
  limit?: number
  /** Only show high-criticality files (hub OR truth-point writer)? Default false. */
  critical_only?: boolean
}

export function codegraphUncovered(args: UncoveredArgs): { content: string } {
  const repoRoot = args.repo_root ?? process.cwd()
  const limit = args.limit ?? 30
  const snapshot = loadSnapshot(repoRoot)

  if (!snapshot.testCoverage) {
    return { content: 'No test coverage data in snapshot. Run `npx codegraph analyze` to refresh.' }
  }

  // Compute in-degree
  const inDeg = new Map<string, number>()
  for (const e of snapshot.edges ?? []) {
    if (e.type === 'import') inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1)
  }

  // Compute writer participation
  const writerOf = new Set<string>()
  for (const tp of snapshot.truthPoints ?? []) {
    for (const w of tp.writers ?? []) writerOf.add(w.file)
  }

  // Score each uncovered entry
  const uncovered = (snapshot.testCoverage.entries ?? [])
    .filter((e: any) => e.testFiles.length === 0)
    .map((e: any) => {
      const id = e.sourceFile
      const inN = inDeg.get(id) ?? 0
      const isWriter = writerOf.has(id)
      let score = 0
      if (inN >= 20) score += 4
      else if (inN >= 5) score += 2
      else if (inN >= 1) score += 1
      if (isWriter) score += 5
      return { sourceFile: id, score, inDegree: inN, isWriter }
    })
    .filter((e: any) => !e.sourceFile.includes('/tests/') && !e.sourceFile.includes('/scripts/') && !e.sourceFile.includes('fixtures/'))

  const filtered = args.critical_only
    ? uncovered.filter((e: any) => e.score >= 3)
    : uncovered

  filtered.sort((a: any, b: any) => b.score - a.score)
  const top = filtered.slice(0, limit)

  if (top.length === 0) {
    return { content: '✅ No uncovered files match the criteria.' }
  }

  const lines: string[] = []
  lines.push(`🧪 ${filtered.length} uncovered file(s) (showing top ${top.length} by criticality):`)
  lines.push('')

  for (const e of top) {
    const flags: string[] = []
    if (e.isWriter) flags.push('truth-point writer')
    if (e.inDegree >= 20) flags.push(`hub (in:${e.inDegree})`)
    else if (e.inDegree >= 5) flags.push(`in:${e.inDegree}`)
    const flagStr = flags.length > 0 ? `  [${flags.join(', ')}]` : ''
    lines.push(`  ${e.sourceFile}${flagStr}`)
  }

  if (filtered.length > top.length) {
    lines.push(`\n... +${filtered.length - top.length} more uncovered`)
  }

  lines.push(`\n💡 Coverage: ${snapshot.testCoverage.coveredFiles}/${snapshot.testCoverage.totalSourceFiles} (${(snapshot.testCoverage.coverageRatio * 100).toFixed(1)}%)`)

  return { content: lines.join('\n') }
}
