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
  const dirsToScan = await resolveDirsToScan(opts)
  return readSessionsFromDirs(dirsToScan, { sinceDays: opts.sinceDays })
}

/**
 * Résout les répertoires de sessions à scanner : le dir du projet courant
 * (s'il existe) + les worktrees `<dir>--claude-worktrees-*` si demandé.
 */
async function resolveDirsToScan(opts: {
  cwd: string
  includeWorktrees?: boolean
}): Promise<string[]> {
  const baseDir = sessionsDir(opts.cwd)
  const dirs: string[] = []
  if (existsSync(baseDir)) dirs.push(baseDir)
  if (!opts.includeWorktrees) return dirs

  const parent = path.dirname(baseDir)
  const baseName = path.basename(baseDir)
  try {
    const siblings = await readdir(parent)
    for (const s of siblings) {
      if (s.startsWith(baseName + '--claude-worktrees-')) dirs.push(path.join(parent, s))
    }
  } catch {
    /* parent dir missing — no worktrees */
  }
  return dirs
}

/** Résultat partiel d'un fichier — mergé déterministiquement par caller. */
interface PartialRead {
  toolUses: ToolUse[]
  sessionIds: string[]
  lineCount: number
  parseErrors: number
}

/**
 * Cœur I/O testable : lit tous les `.jsonl` des `dirs` donnés et agrège les
 * tool_use events. Lectures parallélisées (fichiers indépendants) mais ordre
 * des `toolUses` préservé via concat dans l'ordre des fichiers (déterminisme).
 */
export async function readSessionsFromDirs(
  dirs: string[],
  opts: { sinceDays?: number },
): Promise<SessionsReadResult> {
  const cutoff = Date.now() - (opts.sinceDays ?? 30) * 86_400_000
  const files = await collectSessionFiles(dirs)
  const parts = await Promise.all(files.map((f) => readSessionFile(f, cutoff)))
  return mergeReads(parts)
}

/** Liste les chemins `.jsonl` de tous les dirs (parallèle, ordre des dirs). */
async function collectSessionFiles(dirs: string[]): Promise<string[]> {
  const perDir = await Promise.all(
    dirs.map(async (dir): Promise<string[]> => {
      try {
        const entries = await readdir(dir)
        return entries.filter((e) => e.endsWith('.jsonl')).map((e) => path.join(dir, e))
      } catch {
        return []  // dir manquant : skip
      }
    }),
  )
  return perDir.flat()
}

/** Lit + parse un fichier de session en résultat partiel (jamais throw). */
async function readSessionFile(filePath: string, cutoff: number): Promise<PartialRead> {
  const part: PartialRead = { toolUses: [], sessionIds: [], lineCount: 0, parseErrors: 0 }
  let content: string
  try {
    content = await readFile(filePath, 'utf-8')
  } catch {
    return part  // fichier illisible : skip
  }
  const sessionIds = new Set<string>()
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    part.lineCount++
    try {
      const event = JSON.parse(line) as Record<string, unknown>
      extractToolUses(event, part.toolUses, sessionIds, cutoff)
    } catch {
      part.parseErrors++
    }
  }
  part.sessionIds = [...sessionIds]
  return part
}

/** Fusionne les résultats partiels — concat ordonné des toolUses. */
function mergeReads(parts: PartialRead[]): SessionsReadResult {
  const toolUses: ToolUse[] = []
  const sessionIds = new Set<string>()
  let lineCount = 0
  let parseErrors = 0
  for (const p of parts) {
    toolUses.push(...p.toolUses)
    for (const id of p.sessionIds) sessionIds.add(id)
    lineCount += p.lineCount
    parseErrors += p.parseErrors
  }
  return { toolUses, sessionCount: sessionIds.size, lineCount, parseErrors }
}

function extractToolUses(
  event: Record<string, unknown>,
  acc: ToolUse[],
  sessionIds: Set<string>,
  cutoff: number,
): void {
  if (!isRecentAssistant(event, cutoff)) return

  const sessionId = typeof event.sessionId === 'string' ? event.sessionId : ''
  if (sessionId) sessionIds.add(sessionId)

  const meta = {
    sessionId,
    timestamp: typeof event.timestamp === 'string' ? event.timestamp : '',
    cwd: typeof event.cwd === 'string' ? event.cwd : '',
    gitBranch: typeof event.gitBranch === 'string' ? event.gitBranch : undefined,
  }
  for (const block of messageContentBlocks(event)) {
    const use = toToolUse(block, meta)
    if (use) acc.push(use)
  }
}

/** Event = assistant ET dans la fenêtre de récence ? */
function isRecentAssistant(event: Record<string, unknown>, cutoff: number): boolean {
  if (event.type !== 'assistant') return false
  const ts = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : NaN
  return !(Number.isFinite(ts) && ts < cutoff)
}

/** Blocs de `message.content` (filtre les non-objets), [] si absent. */
function messageContentBlocks(event: Record<string, unknown>): Record<string, unknown>[] {
  const message = event.message as Record<string, unknown> | undefined
  const content = message?.content
  if (!Array.isArray(content)) return []
  return content.filter(
    (b): b is Record<string, unknown> => !!b && typeof b === 'object',
  )
}

/** Convertit un bloc en ToolUse, ou null si ce n'est pas un tool_use. */
function toToolUse(
  block: Record<string, unknown>,
  meta: Omit<ToolUse, 'tool' | 'input'>,
): ToolUse | null {
  if (block.type !== 'tool_use') return null
  const tool = typeof block.name === 'string' ? block.name : 'unknown'
  const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>
  return { ...meta, tool, input }
}
