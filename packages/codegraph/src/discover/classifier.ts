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
  const rootDir = snapshot.rootDir
  const knownFiles = new Set(snapshot.nodes.filter((n) => n.type === 'file').map((n) => n.id))

  const readsByFile = new Map<string, number>()
  const editsByFile = new Map<string, number>()
  const grepsByFile = new Map<string, number>()
  const sessionsByFile = new Map<string, Set<string>>()
  // For repeat-reads in same session :
  const readsByFileBySession = new Map<string, Map<string, number>>()
  // For grep-on-hub-symbol :
  const grepPatterns: Array<{ pattern: string; sessionId: string }> = []

  let reads = 0
  let edits = 0
  let greps = 0
  let bashCalls = 0
  const allSessions = new Set<string>()

  for (const t of toolUses) {
    if (t.sessionId) allSessions.add(t.sessionId)

    if (t.tool === 'Read' || t.tool === 'Edit' || t.tool === 'Write' || t.tool === 'MultiEdit') {
      const filePath = typeof t.input.file_path === 'string' ? t.input.file_path : ''
      const rel = relPath(filePath, rootDir)
      if (!rel) continue

      if (t.tool === 'Read') {
        reads++
        readsByFile.set(rel, (readsByFile.get(rel) ?? 0) + 1)
        let session = readsByFileBySession.get(rel)
        if (!session) {
          session = new Map()
          readsByFileBySession.set(rel, session)
        }
        session.set(t.sessionId, (session.get(t.sessionId) ?? 0) + 1)
      } else {
        edits++
        editsByFile.set(rel, (editsByFile.get(rel) ?? 0) + 1)
      }

      let s = sessionsByFile.get(rel)
      if (!s) {
        s = new Set()
        sessionsByFile.set(rel, s)
      }
      s.add(t.sessionId)
    } else if (t.tool === 'Grep') {
      greps++
      const filePath = typeof t.input.path === 'string' ? t.input.path : ''
      const rel = relPath(filePath, rootDir)
      if (rel) grepsByFile.set(rel, (grepsByFile.get(rel) ?? 0) + 1)
      const pattern = typeof t.input.pattern === 'string' ? t.input.pattern : ''
      if (pattern) grepPatterns.push({ pattern, sessionId: t.sessionId })
    } else if (t.tool === 'Bash') {
      bashCalls++
    }
  }

  // Build hub-reads rows (only files that are in the top-hub set OR have ≥1 read AND known to snapshot)
  const hubReads: DiscoverReportRow[] = []
  for (const [file, readCount] of readsByFile.entries()) {
    const rank = hubRanks.get(file)
    if (rank == null && !knownFiles.has(file)) continue
    if (rank == null) continue // Only top-hubs in this section
    hubReads.push({
      file,
      reads: readCount,
      edits: editsByFile.get(file) ?? 0,
      greps: grepsByFile.get(file) ?? 0,
      inDegree: inDeg.get(file),
      hubRank: rank,
      sessions: sessionsByFile.get(file)?.size ?? 0,
    })
  }
  // Sort : higher reads first, then better hubRank (lower number = more central)
  hubReads.sort((a, b) => b.reads - a.reads || (a.hubRank ?? 999) - (b.hubRank ?? 999))

  // Repeat-reads : same session reading same file ≥ 3 times
  const repeatReads: Array<{ sessionId: string; file: string; reads: number }> = []
  for (const [file, sessions] of readsByFileBySession.entries()) {
    for (const [sessionId, n] of sessions.entries()) {
      if (n >= 3) repeatReads.push({ sessionId, file, reads: n })
    }
  }
  repeatReads.sort((a, b) => b.reads - a.reads)

  // Grep-on-hub-symbol : match grep pattern against last segment of a hub file id
  const grepOnHubSymbols: Array<{ pattern: string; matchedHubFile: string; count: number }> = []
  const grepByPattern = new Map<string, { count: number; matched?: string }>()
  for (const { pattern } of grepPatterns) {
    const key = pattern
    let entry = grepByPattern.get(key)
    if (!entry) {
      entry = { count: 0 }
      grepByPattern.set(key, entry)
    }
    entry.count++
    if (!entry.matched) {
      // Try to match pattern against an exported symbol-like identifier inside a hub
      const ident = pattern.replace(/[^A-Za-z0-9_]/g, '')
      if (ident.length >= 4) {
        for (const hubFile of hubRanks.keys()) {
          const stem = hubFile.split('/').pop()?.replace(/\.tsx?$/, '') ?? ''
          if (stem && (stem === ident || stem.toLowerCase() === ident.toLowerCase())) {
            entry.matched = hubFile
            break
          }
        }
      }
    }
  }
  for (const [pattern, { count, matched }] of grepByPattern.entries()) {
    if (matched) grepOnHubSymbols.push({ pattern, matchedHubFile: matched, count })
  }
  grepOnHubSymbols.sort((a, b) => b.count - a.count)

  return {
    totals: {
      sessions: allSessions.size,
      toolUses: toolUses.length,
      reads,
      edits,
      greps,
      bashCalls,
    },
    hubReads: hubReads.slice(0, 20),
    repeatReads: repeatReads.slice(0, 20),
    grepOnHubSymbols: grepOnHubSymbols.slice(0, 10),
  }
}
