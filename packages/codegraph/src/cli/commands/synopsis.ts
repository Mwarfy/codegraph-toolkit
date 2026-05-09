// ADR-005
/**
 * `codegraph synopsis` — generate a synopsis (mental map) from a snapshot.
 *
 * Two modes :
 *   1. Static C4-style levels (default) : --level 1|2|3 (existing behavior)
 *   2. Focused dynamic : --focus <file>... [--tokens N]
 *      Personalized PageRank-ranked vue centrée sur les files passés en
 *      focus. Sortie markdown qui rentre dans le token budget donné.
 *
 * Cas d'usage focused : un agent qui veut "quoi connaître pour modifier
 * X ?" sans charger tout le snopsis. Le ranking surface les fichiers
 * structurellement pertinents (1-hop + co-change + hubs transitifs).
 *
 * Extrait du god-file `cli/index.ts` (P2b split) avec extension --focus.
 */

import chalk from 'chalk'
import { buildSynopsis, renderLevel1, renderLevel2, renderLevel3 } from '../../synopsis/builder.js'
import { renderFocusedSynopsis } from '../../synopsis/focused.js'
import { collectAdrMarkers } from '../../synopsis/adr-markers.js'
import { loadConfig, loadSnapshot } from '../_shared.js'

export interface SynopsisOpts {
  config?: string
  level?: string
  container?: string
  format?: string
  focus?: string[]
  tokens?: string
  recent?: boolean
}

export async function runSynopsisCommand(snapshotPath: string | undefined, opts: SynopsisOpts): Promise<void> {
  const snapshot = await loadSnapshot(snapshotPath, opts)

  // ─── Mode focused (--focus <file>) ───────────────────────────
  if (opts.focus && opts.focus.length > 0) {
    if (opts.format === 'json') {
      const { rankFiles } = await import('../../synopsis/rank.js')
      const recentlyModified = opts.recent ? await getRecentlyModified() : undefined
      const ranked = rankFiles(snapshot, { focus: opts.focus, recentlyModified })
      process.stdout.write(JSON.stringify({
        focus: opts.focus,
        ranked,
      }, null, 2))
      return
    }
    const tokens = parseInt(opts.tokens ?? '1500', 10)
    const recentlyModified = opts.recent ? await getRecentlyModified() : undefined
    const md = renderFocusedSynopsis(snapshot, {
      focus: opts.focus,
      tokens,
      recentlyModified,
    })
    process.stdout.write(md)
    return
  }

  // ─── Mode statique (default) ─────────────────────────────────
  const cfg = await loadConfig(opts)
  const adrMarkers = await collectAdrMarkers(cfg.rootDir)
  const synopsis = buildSynopsis(snapshot, { adrMarkers })

  if (opts.format === 'json') {
    process.stdout.write(JSON.stringify(synopsis, null, 2))
    return
  }

  const level = parseInt(opts.level ?? '1', 10)
  let out: string
  if (level === 1) out = renderLevel1(synopsis)
  else if (level === 2) out = renderLevel2(synopsis)
  else if (level === 3) {
    if (!opts.container) {
      console.error(chalk.red('--container <id> required for Level 3'))
      console.error(chalk.dim(`Available: ${synopsis.containers.map((c) => c.id).join(', ')}`))
      process.exit(1)
    }
    out = renderLevel3(synopsis, opts.container)
  } else {
    console.error(chalk.red(`Invalid level: ${opts.level} (expected 1, 2, or 3)`))
    process.exit(1)
  }

  process.stdout.write(out)
}

async function getRecentlyModified(): Promise<string[]> {
  try {
    const { execSync } = await import('node:child_process')
    const out = execSync(
      'git log --no-merges --since="3.weeks.ago" --name-only --pretty=format:',
      { cwd: process.cwd(), encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] },
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
