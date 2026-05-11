/**
 * Classifie les tool_use des sessions et identifie où l'injection contextuelle
 * a probablement raté.
 *
 * Signaux retenus (MVP) :
 *   1. **hub-reads** — Read sur un fichier dans le top in-degree du snapshot.
 *      Symptôme : le synopsis n'a pas suffi à éviter une lecture exploratoire
 *      d'un fichier qui est par définition load-bearing.
 *   2. **repeat-reads** — Même fichier lu plusieurs fois dans la même session
 *      (≥3). Symptôme : context manqué côté LLM ou hook qui ne propage pas.
 *   3. **grep-on-hub-symbol** — Grep dont le pattern matche un export d'un
 *      top hub. Symptôme : le LLM a cherché ce que le synopsis aurait pu dire.
 *
 * Sortie : structure de report agrégée — orchestrateur formate (markdown / json).
 */

import type { ToolUse } from './session-reader.js'

export interface DiscoverReportRow {
  file: string
  reads: number
  edits: number
  greps: number
  inDegree?: number
  hubRank?: number
  /** Number of distinct sessions where this file was touched. */
  sessions: number
}

export interface DiscoverReport {
  totals: {
    sessions: number
    toolUses: number
    reads: number
    edits: number
    greps: number
    bashCalls: number
  }
  /** Files ranked by hub-read signal (Read count × hub rank weight). */
  hubReads: DiscoverReportRow[]
  /** Files read ≥ 3 times in same session. */
  repeatReads: Array<{ sessionId: string; file: string; reads: number }>
  /** Grep patterns that look like hub-related symbols. */
  grepOnHubSymbols: Array<{ pattern: string; matchedHubFile: string; count: number }>
}

interface NodeLike {
  id: string
  type?: string
}

interface SnapshotLike {
  nodes: NodeLike[]
  edges?: Array<{ from: string; to: string; type?: string }>
  rootDir?: string
}

const HUB_RANK_LIMIT = 15

/**
 * Compute in-degree per file from snapshot edges. Falls back to empty map if
 * edges missing.
 */
function computeInDegrees(snapshot: SnapshotLike): Map<string, number> {
  const inDeg = new Map<string, number>()
  if (!snapshot.edges) return inDeg
  for (const e of snapshot.edges) {
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1)
  }
  return inDeg
}

/** Top N files by in-degree, ranked. */
function topHubs(inDeg: Map<string, number>, limit = HUB_RANK_LIMIT): Map<string, number> {
  const sorted = [...inDeg.entries()]
    .filter(([_id, n]) => n >= 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
  const ranks = new Map<string, number>()
  sorted.forEach(([id], i) => ranks.set(id, i + 1))
  return ranks
}

/**
 * Resolve a tool's `file_path` (which is absolute in the session JSONL) to a
 * snapshot-relative path. Returns null if outside the project root.
 */
function relPath(absPath: string, rootDir: string | undefined): string | null {
  if (!absPath || typeof absPath !== 'string') return null
  if (!rootDir) return absPath
  if (!absPath.startsWith(rootDir + '/')) return null
  return absPath.slice(rootDir.length + 1)
}

export function classify(toolUses: ToolUse[], snapshot: SnapshotLike): DiscoverReport {
  const inDeg = computeInDegrees(snapshot)
  const hubRanks = topHubs(inDeg)
  const knownFiles = new Set(snapshot.nodes.filter((n) => n.type === 'file').map((n) => n.id))

  // ADR-029 — extraction des 4 sous-phases en helpers top-level (=
  // visités séparément par le visitor pour réduire le cyclo de classify
  // qui était à 46).
  const stats = extractFileStats(toolUses, snapshot.rootDir)
  const hubReads = buildHubReadsRows(stats, inDeg, hubRanks, knownFiles)
  const repeatReads = buildRepeatReads(stats.readsByFileBySession)
  const grepOnHubSymbols = buildGrepOnHubSymbols(stats.grepPatterns, hubRanks)

  return {
    totals: {
      sessions: stats.allSessions.size,
      toolUses: toolUses.length,
      reads: stats.reads,
      edits: stats.edits,
      greps: stats.greps,
      bashCalls: stats.bashCalls,
    },
    hubReads: hubReads.slice(0, 20),
    repeatReads: repeatReads.slice(0, 20),
    grepOnHubSymbols: grepOnHubSymbols.slice(0, 10),
  }
}

// ─── Phase 1 : accumulate per-file stats from tool uses ─────────────────────

interface FileStats {
  reads: number
  edits: number
  greps: number
  bashCalls: number
  readsByFile: Map<string, number>
  editsByFile: Map<string, number>
  grepsByFile: Map<string, number>
  sessionsByFile: Map<string, Set<string>>
  readsByFileBySession: Map<string, Map<string, number>>
  grepPatterns: Array<{ pattern: string; sessionId: string }>
  allSessions: Set<string>
}

function emptyFileStats(): FileStats {
  return {
    reads: 0, edits: 0, greps: 0, bashCalls: 0,
    readsByFile: new Map(),
    editsByFile: new Map(),
    grepsByFile: new Map(),
    sessionsByFile: new Map(),
    readsByFileBySession: new Map(),
    grepPatterns: [],
    allSessions: new Set(),
  }
}

function extractFileStats(toolUses: ToolUse[], rootDir: string | undefined): FileStats {
  const stats = emptyFileStats()
  for (const t of toolUses) {
    if (t.sessionId) stats.allSessions.add(t.sessionId)
    if (t.tool === 'Read' || t.tool === 'Edit' || t.tool === 'Write' || t.tool === 'MultiEdit') {
      handleFileTool(t, rootDir, stats)
    } else if (t.tool === 'Grep') {
      handleGrep(t, rootDir, stats)
    } else if (t.tool === 'Bash') {
      stats.bashCalls++
    }
  }
  return stats
}

function handleFileTool(t: ToolUse, rootDir: string | undefined, stats: FileStats): void {
  const filePath = typeof t.input.file_path === 'string' ? t.input.file_path : ''
  const rel = relPath(filePath, rootDir)
  if (!rel) return

  if (t.tool === 'Read') {
    stats.reads++
    stats.readsByFile.set(rel, (stats.readsByFile.get(rel) ?? 0) + 1)
    let session = stats.readsByFileBySession.get(rel)
    if (!session) {
      session = new Map()
      stats.readsByFileBySession.set(rel, session)
    }
    session.set(t.sessionId, (session.get(t.sessionId) ?? 0) + 1)
  } else {
    stats.edits++
    stats.editsByFile.set(rel, (stats.editsByFile.get(rel) ?? 0) + 1)
  }

  let s = stats.sessionsByFile.get(rel)
  if (!s) {
    s = new Set()
    stats.sessionsByFile.set(rel, s)
  }
  s.add(t.sessionId)
}

function handleGrep(t: ToolUse, rootDir: string | undefined, stats: FileStats): void {
  stats.greps++
  const filePath = typeof t.input.path === 'string' ? t.input.path : ''
  const rel = relPath(filePath, rootDir)
  if (rel) stats.grepsByFile.set(rel, (stats.grepsByFile.get(rel) ?? 0) + 1)
  const pattern = typeof t.input.pattern === 'string' ? t.input.pattern : ''
  if (pattern) stats.grepPatterns.push({ pattern, sessionId: t.sessionId })
}

// ─── Phase 2 : derive hub-reads rows from stats + snapshot context ──────────

function buildHubReadsRows(
  stats: FileStats,
  inDeg: Map<string, number>,
  hubRanks: Map<string, number>,
  knownFiles: Set<string>,
): DiscoverReportRow[] {
  const rows: DiscoverReportRow[] = []
  for (const [file, readCount] of stats.readsByFile.entries()) {
    const rank = hubRanks.get(file)
    if (rank == null && !knownFiles.has(file)) continue
    if (rank == null) continue // Only top-hubs in this section
    rows.push({
      file,
      reads: readCount,
      edits: stats.editsByFile.get(file) ?? 0,
      greps: stats.grepsByFile.get(file) ?? 0,
      inDegree: inDeg.get(file),
      hubRank: rank,
      sessions: stats.sessionsByFile.get(file)?.size ?? 0,
    })
  }
  rows.sort((a, b) => b.reads - a.reads || (a.hubRank ?? 999) - (b.hubRank ?? 999))
  return rows
}

// ─── Phase 3 : repeat-reads (same session ≥ 3 reads of same file) ──────────

function buildRepeatReads(
  readsByFileBySession: Map<string, Map<string, number>>,
): Array<{ sessionId: string; file: string; reads: number }> {
  const out: Array<{ sessionId: string; file: string; reads: number }> = []
  for (const [file, sessions] of readsByFileBySession.entries()) {
    for (const [sessionId, n] of sessions.entries()) {
      if (n >= 3) out.push({ sessionId, file, reads: n })
    }
  }
  out.sort((a, b) => b.reads - a.reads)
  return out
}

// ─── Phase 4 : grep-on-hub-symbol matching ──────────────────────────────────

function buildGrepOnHubSymbols(
  grepPatterns: Array<{ pattern: string; sessionId: string }>,
  hubRanks: Map<string, number>,
): Array<{ pattern: string; matchedHubFile: string; count: number }> {
  const grepByPattern = new Map<string, { count: number; matched?: string }>()
  for (const { pattern } of grepPatterns) {
    let entry = grepByPattern.get(pattern)
    if (!entry) {
      entry = { count: 0 }
      grepByPattern.set(pattern, entry)
    }
    entry.count++
    if (!entry.matched) {
      const matched = matchPatternToHub(pattern, hubRanks)
      if (matched) entry.matched = matched
    }
  }
  const out: Array<{ pattern: string; matchedHubFile: string; count: number }> = []
  for (const [pattern, { count, matched }] of grepByPattern.entries()) {
    if (matched) out.push({ pattern, matchedHubFile: matched, count })
  }
  out.sort((a, b) => b.count - a.count)
  return out
}

/** Try to match grep pattern against an exported symbol-like identifier inside a hub. */
function matchPatternToHub(pattern: string, hubRanks: Map<string, number>): string | null {
  const ident = pattern.replace(/[^A-Za-z0-9_]/g, '')
  if (ident.length < 4) return null
  for (const hubFile of hubRanks.keys()) {
    const stem = hubFile.split('/').pop()?.replace(/\.tsx?$/, '') ?? ''
    if (stem && (stem === ident || stem.toLowerCase() === ident.toLowerCase())) {
      return hubFile
    }
  }
  return null
}
