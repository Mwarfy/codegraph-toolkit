/**
 * codegraph_co_changed(file_path) — paires de fichiers fréquemment
 * co-modifiés avec le file donné. Source: snapshot.coChangePairs
 * (extracteur co-change, axe 2 enrichissement).
 *
 * Utile pour : "tu touches reporter.ts ? les 5 dernières fois t'as
 * aussi touché alert-system.ts" — signal couplage opérationnel non
 * codifié dans les imports.
 */

import * as path from 'node:path'
import { loadSnapshot } from '../snapshot-loader.js'

export interface CoChangedArgs {
  file_path: string
  repo_root?: string
  /** Limit du top-N retourné. Default 10. */
  limit?: number
  /** Seuil minimum de jaccard (filtre paires diluées). Default 0. */
  min_jaccard?: number
}

export function codegraphCoChanged(args: CoChangedArgs): { content: string } {
  const repoRoot = args.repo_root ?? process.cwd()
  const limit = args.limit ?? 10
  const minJaccard = args.min_jaccard ?? 0

  const relPath = path.isAbsolute(args.file_path)
    ? path.relative(repoRoot, args.file_path).replace(/\\/g, '/')
    : args.file_path.replace(/\\/g, '/')

  const snapshot = loadSnapshot(repoRoot)
  type Pair = {
    from: string
    to: string
    count: number
    totalCommitsFrom: number
    totalCommitsTo: number
    jaccard: number
  }
  const pairs: Pair[] = snapshot.coChangePairs ?? []

  if (pairs.length === 0) {
    return {
      content:
        'No co-change data in snapshot (or none above threshold). ' +
        'Run `npx codegraph analyze` to refresh — extractor needs git history.',
    }
  }

  // Filter pairs touching this file (either side).
  const matches = pairs
    .filter((p) => p.from === relPath || p.to === relPath)
    .filter((p) => p.jaccard >= minJaccard)
    .map((p) => ({
      other: p.from === relPath ? p.to : p.from,
      count: p.count,
      jaccard: p.jaccard,
      totalCommits: p.from === relPath ? p.totalCommitsFrom : p.totalCommitsTo,
      otherTotal: p.from === relPath ? p.totalCommitsTo : p.totalCommitsFrom,
    }))
    .sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count
      return b.jaccard - a.jaccard
    })
    .slice(0, limit)

  if (matches.length === 0) {
    return {
      content: `No co-changed files for ${relPath} above threshold (minCount=3 by default in extractor).`,
    }
  }

  const lines: string[] = []
  lines.push(`🔗 Co-changed files for ${relPath} (last 90 days, top ${limit}):`)
  lines.push('')
  for (const m of matches) {
    const j = m.jaccard.toFixed(2)
    lines.push(`  ${m.count}× (j=${j})  ${m.other}`)
    lines.push(`           ${relPath} touched ${m.totalCommits}× total · ${m.other} touched ${m.otherTotal}× total`)
  }
  lines.push('')
  lines.push(
    'jaccard = co-changes / (totalA + totalB − co-changes). High j means the two ' +
    'files really go together; low j means one is changed often regardless.',
  )

  return { content: lines.join('\n') }
}
