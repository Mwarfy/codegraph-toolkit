/**
 * Lit les sessions Claude Code (`~/.claude/projects/<encoded-cwd>/*.jsonl`)
 * et en extrait les tool_use events pertinents pour l'analyse `discover`.
 *
 * Format JSONL : une ligne = un event JSON.
 *   - `type: "assistant"` avec `message.content[].type === "tool_use"` → tool call
 *   - Metadata : `sessionId`, `timestamp`, `cwd`, `gitBranch`
 *
 * Le projet courant est encodé par Claude Code en remplaçant `/` par `-` dans
 * le path absolu : `/Users/x/Documents/foo` → `-Users-x-Documents-foo`. Les
 * worktrees apparaissent comme `-Users-...-foo--claude-worktrees-<name>`.
 *
 * cf. ADR-026 + ADR-027 — direction Glean, observer où l'injection contextuelle
 * rate via les sessions historiques.
 */

import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

export type ToolName = 'Read' | 'Edit' | 'Write' | 'MultiEdit' | 'Grep' | 'Glob' | 'Bash' | 'WebFetch' | 'WebSearch' | string

export interface ToolUse {
  sessionId: string
  timestamp: string
  cwd: string
  gitBranch?: string
  tool: ToolName
  input: Record<string, unknown>
}

export interface SessionsReadResult {
  toolUses: ToolUse[]
  sessionCount: number
  lineCount: number
  parseErrors: number
}

/** Encode un cwd absolu vers le nom de dir Claude Code (substitue `/` par `-`). */
export function encodeProjectPath(cwd: string): string {
  return cwd.replace(/\//g, '-')
}

/** Locate the Claude sessions dir for a given project cwd. */
export function sessionsDir(cwd: string): string {
  return path.join(os.homedir(), '.claude', 'projects', encodeProjectPath(cwd))
}

/**
 * Reads all session JSONL files in `dir` and returns the parsed tool_use
 * events. Errors per-line are counted but never throw — partial sessions
 * shouldn't kill the whole analysis.
 *
 * Filtres : keep only events <= `sinceDays` days old (default: 30).
 * Si `includeWorktrees`, scanne aussi `<dir>--claude-worktrees-*`.
 */
export async function readSessions(opts: {
  cwd: string
  sinceDays?: number
  includeWorktrees?: boolean
}): Promise<SessionsReadResult> {
  const since = opts.sinceDays ?? 30
  const cutoff = Date.now() - since * 86_400_000

  const baseDir = sessionsDir(opts.cwd)
  const dirsToScan: string[] = []
  if (existsSync(baseDir)) dirsToScan.push(baseDir)

  if (opts.includeWorktrees) {
    const parent = path.dirname(baseDir)
    const baseName = path.basename(baseDir)
    try {
      const siblings = await readdir(parent)
      for (const s of siblings) {
        if (s.startsWith(baseName + '--claude-worktrees-')) {
          dirsToScan.push(path.join(parent, s))
        }
      }
    } catch {
      /* parent dir missing — no worktrees */
    }
  }

  const toolUses: ToolUse[] = []
  const sessionIds = new Set<string>()
  let lineCount = 0
  let parseErrors = 0

  for (const dir of dirsToScan) {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue
      const filePath = path.join(dir, entry)
      let content: string
      try {
        content = await readFile(filePath, 'utf-8')
      } catch {
        continue
      }
      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        lineCount++
        try {
          const event = JSON.parse(line) as Record<string, unknown>
          extractToolUses(event, toolUses, sessionIds, cutoff)
        } catch {
          parseErrors++
        }
      }
    }
  }

  return { toolUses, sessionCount: sessionIds.size, lineCount, parseErrors }
}

function extractToolUses(
  event: Record<string, unknown>,
  acc: ToolUse[],
  sessionIds: Set<string>,
  cutoff: number,
): void {
  if (event.type !== 'assistant') return
  const ts = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : NaN
  if (Number.isFinite(ts) && ts < cutoff) return

  const sessionId = typeof event.sessionId === 'string' ? event.sessionId : ''
  if (sessionId) sessionIds.add(sessionId)

  const message = event.message as Record<string, unknown> | undefined
  if (!message) return
  const content = message.content
  if (!Array.isArray(content)) return

  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    if (b.type !== 'tool_use') continue
    const tool = typeof b.name === 'string' ? b.name : 'unknown'
    const input = (b.input && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown>

    acc.push({
      sessionId,
      timestamp: typeof event.timestamp === 'string' ? event.timestamp : '',
      cwd: typeof event.cwd === 'string' ? event.cwd : '',
      gitBranch: typeof event.gitBranch === 'string' ? event.gitBranch : undefined,
      tool,
      input,
    })
  }
}
