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

interface UncoveredEntry {
  sourceFile: string
  score: number
  inDegree: number
  isWriter: boolean
}

export function codegraphUncovered(args: UncoveredArgs): { content: string } {
  const repoRoot = args.repo_root ?? process.cwd()
  const limit = args.limit ?? 30
  const snapshot = loadSnapshot(repoRoot)

  if (!snapshot.testCoverage) {
    return { content: 'No test coverage data in snapshot. Run `npx codegraph analyze` to refresh.' }
  }

  const inDeg = computeImportInDegree(snapshot.edges ?? [])
  const writerOf = collectTruthPointWriters(snapshot.truthPoints ?? [])
  const uncovered = scoreUncoveredEntries(snapshot.testCoverage.entries ?? [], inDeg, writerOf)
  const filtered = args.critical_only ? uncovered.filter((e) => e.score >= 3) : uncovered

  filtered.sort((a, b) => b.score - a.score)
  const top = filtered.slice(0, limit)

  if (top.length === 0) return { content: '✅ No uncovered files match the criteria.' }

  return { content: formatUncoveredOutput(filtered, top, snapshot.testCoverage) }
}

function computeImportInDegree(edges: ReadonlyArray<{ type: string; to: string }>): Map<string, number> {
  const inDeg = new Map<string, number>()
  for (const e of edges) {
    if (e.type === 'import') inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1)
  }
  return inDeg
}

function collectTruthPointWriters(
  truthPoints: ReadonlyArray<{ writers?: ReadonlyArray<{ file: string }> }>,
): Set<string> {
  const writerOf = new Set<string>()
  for (const tp of truthPoints) {
    for (const w of tp.writers ?? []) writerOf.add(w.file)
  }
  return writerOf
}

function scoreUncoveredEntries(
  entries: ReadonlyArray<any>,
  inDeg: Map<string, number>,
  writerOf: Set<string>,
): UncoveredEntry[] {
  return entries
    .filter((e: any) => e.testFiles.length === 0)
    .map((e: any): UncoveredEntry => {
      const id = e.sourceFile
      const inN = inDeg.get(id) ?? 0
      const isWriter = writerOf.has(id)
      return { sourceFile: id, score: scoreEntry(inN, isWriter), inDegree: inN, isWriter }
    })
    .filter((e) => !isExcludedPath(e.sourceFile))
}

function scoreEntry(inDegree: number, isWriter: boolean): number {
  let score = 0
  if (inDegree >= 20) score += 4
  else if (inDegree >= 5) score += 2
  else if (inDegree >= 1) score += 1
  if (isWriter) score += 5
  return score
}

function isExcludedPath(file: string): boolean {
  return file.includes('/tests/')
    || file.includes('/scripts/')
    || file.includes('fixtures/')
}

interface CoverageStats {
  coveredFiles: number
  totalSourceFiles: number
  coverageRatio: number
}

function formatUncoveredOutput(
  filtered: UncoveredEntry[],
  top: UncoveredEntry[],
  coverage: CoverageStats,
): string {
  const lines: string[] = []
  lines.push(`🧪 ${filtered.length} uncovered file(s) (showing top ${top.length} by criticality):`)
  lines.push('')
  for (const e of top) {
    lines.push(`  ${e.sourceFile}${formatFlags(e)}`)
  }
  if (filtered.length > top.length) {
    lines.push(`\n... +${filtered.length - top.length} more uncovered`)
  }
  lines.push(
    `\n💡 Coverage: ${coverage.coveredFiles}/${coverage.totalSourceFiles} ` +
    `(${(coverage.coverageRatio * 100).toFixed(1)}%)`,
  )
  return lines.join('\n')
}

function formatFlags(e: UncoveredEntry): string {
  const flags: string[] = []
  if (e.isWriter) flags.push('truth-point writer')
  if (e.inDegree >= 20) flags.push(`hub (in:${e.inDegree})`)
  else if (e.inDegree >= 5) flags.push(`in:${e.inDegree}`)
  return flags.length > 0 ? `  [${flags.join(', ')}]` : ''
}
