/**
 * codegraph_extract_candidates(file_path) — fonctions candidates fortes
 * à l'extraction (extract method).
 *
 * Croise `snapshot.longFunctions` (du file) avec `snapshot.symbolRefs`
 * (count des refs entrantes par symbol). Score = LOC × (1 + fanIn/5)
 * — favorise les longues fonctions très appelées (cognitive load × blast
 * radius). Les petites fonctions à fort fanIn ne sont PAS candidates
 * (elles sont déjà extraites). Les longues sans appelant non plus
 * (probablement entry points / scripts).
 *
 * Cf. axe 1 du plan d'enrichissement (docs/ENRICHMENT-5-AXES-PLAN.md).
 */

import * as path from 'node:path'
import { loadSnapshot } from '../snapshot-loader.js'

export interface ExtractCandidatesArgs {
  file_path: string
  repo_root?: string
  /** Top-N retournés. Default 5. */
  limit?: number
  /** LOC minimum pour qu'une fonction soit candidate. Default 50. */
  min_loc?: number
}

type LongFn = { file: string; name: string; line: number; loc: number; kind: string }
type SymRef = { from: string; to: string; line: number }
interface ScoredCandidate extends LongFn { fanIn: number; score: number; symbol: string }

export function codegraphExtractCandidates(args: ExtractCandidatesArgs): { content: string } {
  const repoRoot = args.repo_root ?? process.cwd()
  const limit = args.limit ?? 5
  const minLoc = args.min_loc ?? 50
  const relPath = normalizeRelPath(repoRoot, args.file_path)

  const snapshot = loadSnapshot(repoRoot)
  const fileFns = (snapshot.longFunctions ?? []).filter(
    (f: LongFn) => f.file === relPath && f.loc >= minLoc,
  )
  if (fileFns.length === 0) {
    return {
      content: `No long functions (>= ${minLoc} LOC) in ${relPath}. ` +
        'File is either small or already well-decomposed.',
    }
  }

  const fanInBySymbol = computeFanInIndex(snapshot.symbolRefs ?? [])
  const scored = scoreCandidates(fileFns, fanInBySymbol).slice(0, limit)
  return { content: formatCandidates(relPath, limit, scored) }
}

function normalizeRelPath(repoRoot: string, filePath: string): string {
  return path.isAbsolute(filePath)
    ? path.relative(repoRoot, filePath).replace(/\\/g, '/')
    : filePath.replace(/\\/g, '/')
}

function computeFanInIndex(refs: SymRef[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of refs) out.set(r.to, (out.get(r.to) ?? 0) + 1)
  return out
}

function scoreCandidates(
  fileFns: LongFn[],
  fanInBySymbol: Map<string, number>,
): ScoredCandidate[] {
  return fileFns
    .map((f) => {
      const symbol = `${f.file}:${f.name}`
      const fanIn = fanInBySymbol.get(symbol) ?? 0
      const score = f.loc * (1 + fanIn / 5)
      return { ...f, fanIn, score, symbol }
    })
    .sort((a, b) => b.score - a.score)
}

function formatCandidates(
  relPath: string,
  limit: number,
  scored: ScoredCandidate[],
): string {
  const lines: string[] = []
  lines.push(`🪓 Extract-method candidates in ${relPath} (top ${limit}):`)
  lines.push('')
  lines.push('  score = loc × (1 + fanIn/5) — favors long & called-often functions')
  lines.push('')
  for (const c of scored) {
    appendCandidateBlock(c, lines)
  }
  lines.push('')
  lines.push(
    'Hint: use `lsp_find_symbol` then `lsp_hover` for the actual function ' +
    'body before extracting. Consider keeping the public signature stable.',
  )
  return lines.join('\n')
}

function appendCandidateBlock(c: ScoredCandidate, lines: string[]): void {
  const fanInDesc = c.fanIn === 0
    ? 'never called (entry point ?)'
    : `called ${c.fanIn}× by other symbols`
  lines.push(`  [${c.score.toFixed(0)}]  ${c.name}  (${c.kind}, line ${c.line})`)
  lines.push(`     ${c.loc} LOC · ${fanInDesc}`)
  // Heuristique : si la fonction est appelée et longue, suggérer extraction.
  if (c.fanIn >= 3 && c.loc >= 80) {
    lines.push(`     ⚠ HOT extract candidate — long AND high blast radius`)
  } else if (c.fanIn === 0 && c.loc >= 100) {
    lines.push(`     ↪ orchestrator-style: extract internal phases as private helpers`)
  }
}
