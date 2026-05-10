/**
 * `codegraph discover` — scan les sessions Claude Code historiques et identifie
 * les ratés d'injection contextuelle (hub reads, repeat reads, grep on hub names).
 *
 * Inspiré de `rtk discover` (RTK), adapté pour mesurer où le synopsis / hooks
 * ADR auraient pu éviter une exploration côté LLM. Reads et Edits sont
 * extraits des JSONL `~/.claude/projects/<encoded-cwd>/*.jsonl` puis croisés
 * avec le snapshot codegraph courant.
 *
 * cf. ADR-026 (Datalog rules), ADR-027 (direction Glean — observer le ratio
 * signal/bruit du contexte LLM).
 */

import * as path from 'node:path'
import { readSessions, classify, formatReport } from '../../discover/index.js'
import { loadSnapshot } from '../_shared.js'

export interface DiscoverOpts {
  config?: string
  project?: string
  sinceDays?: string | number
  worktrees?: boolean
  json?: boolean
}

export async function runDiscoverCommand(snapshotPath: string | undefined, opts: DiscoverOpts): Promise<void> {
  const cwd = opts.project ? path.resolve(opts.project) : process.cwd()
  const sinceDays = typeof opts.sinceDays === 'string' ? parseInt(opts.sinceDays, 10) : opts.sinceDays ?? 30

  const sessions = await readSessions({
    cwd,
    sinceDays: Number.isFinite(sinceDays) ? sinceDays : 30,
    includeWorktrees: opts.worktrees ?? true,
  })

  const snapshot = await loadSnapshot(snapshotPath, opts)
  const report = classify(sessions.toolUses, snapshot)

  if (opts.json) {
    console.log(JSON.stringify({
      cwd,
      sinceDays,
      sessionsRead: sessions.sessionCount,
      lineCount: sessions.lineCount,
      parseErrors: sessions.parseErrors,
      report,
    }, null, 2))
    return
  }

  if (sessions.toolUses.length === 0) {
    console.log(`\n  No session events found under ~/.claude/projects/ for ${cwd} (last ${sinceDays} days).`)
    console.log('  Run a Claude Code session in this project then re-try.\n')
    return
  }

  console.log()
  console.log(`  Scanned ${sessions.sessionCount} session(s), ${sessions.lineCount} event lines (${sessions.parseErrors} parse errors).`)
  console.log()
  console.log(formatReport(report))
}
