// ADR-005
/**
 * `codegraph rank --focus <file>...` — affiche les fichiers les plus
 * pertinents pour un focus donné, via personalized PageRank sur le
 * snapshot.
 *
 * Cas d'usage principal : un agent IA qui veut savoir "quels fichiers
 * lire avant de modifier X ?". Au lieu d'injecter tout le synopsis,
 * il appelle `codegraph rank --focus X --top 30` et reçoit la liste
 * triée par pertinence avec raisons explicites.
 *
 * Mode JSON pour consommation par le hook codegraph-feedback.
 */

import chalk from 'chalk'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { rankFiles, type RankedFile } from '../../synopsis/rank.js'
import { loadSnapshot } from '../_shared.js'

export interface RankOpts {
  config?: string
  focus?: string[]
  top?: string
  json?: boolean
  recent?: boolean
}

export async function runRankCommand(opts: RankOpts): Promise<void> {
  const focus = opts.focus ?? []
  const top = parseInt(opts.top ?? '30', 10)

  if (focus.length === 0) {
    console.error(chalk.yellow('  ⚠ pass at least one --focus <file>'))
    console.error(chalk.dim('    Example: codegraph rank --focus packages/codegraph/src/cli/index.ts'))
    process.exit(1)
  }

  const snapshot = await loadSnapshot(undefined, opts)

  // Validate focus files exist in the snapshot
  const fileIds = new Set(
    snapshot.nodes.filter((n) => n.type === 'file').map((n) => n.id),
  )
  const missing = focus.filter((f) => !fileIds.has(f))
  if (missing.length > 0) {
    console.error(chalk.yellow(`  ⚠ focus file(s) not in snapshot:`))
    for (const f of missing) console.error(chalk.dim(`    - ${f}`))
    console.error(chalk.dim('  Run `codegraph analyze` first or check the path.'))
  }

  // Optional recent-modified soft signal
  let recentlyModified: string[] | undefined
  if (opts.recent) {
    recentlyModified = await getRecentlyModifiedFiles(process.cwd())
  }

  const ranked = rankFiles(snapshot, { focus, recentlyModified })
  const sliced = ranked.slice(0, top)

  if (opts.json) {
    console.log(JSON.stringify({
      focus,
      total: ranked.length,
      shown: sliced.length,
      results: sliced,
    }, null, 2))
    return
  }

  console.log(chalk.bold(`\n  PageRank — focus: ${focus.join(', ')}\n`))
  console.log(chalk.dim(`  ${ranked.length} files ranked, showing top ${sliced.length}`))
  console.log()

  const maxScore = sliced[0]?.score ?? 1
  for (let i = 0; i < sliced.length; i++) {
    const r = sliced[i]
    const rank = String(i + 1).padStart(3)
    const scoreStr = r.score.toFixed(5)
    const isFocus = focus.includes(r.file)
    const fileLabel = isFocus ? chalk.cyan(chalk.bold(r.file)) : r.file
    const bar = renderBar(r.score / maxScore, 10)
    console.log(`  ${rank}. ${chalk.dim(scoreStr)} ${bar}  ${fileLabel}`)
    if (r.reasons.length > 0) {
      console.log(chalk.dim(`         ${r.reasons.slice(0, 3).join(' · ')}`))
    }
  }
  console.log()
}

function renderBar(ratio: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)))
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled)
  return chalk.dim(bar)
}

async function getRecentlyModifiedFiles(cwd: string): Promise<string[]> {
  try {
    const { execSync } = await import('node:child_process')
    const out = execSync(
      'git log --no-merges --since="3.weeks.ago" --name-only --pretty=format:',
      { cwd, encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString().trim()
    const files = new Set<string>()
    for (const line of out.split('\n')) {
      const f = line.trim()
      if (f.length > 0) files.add(f)
    }
    return [...files]
  } catch {
    return []
  }
}

void path
void fs
