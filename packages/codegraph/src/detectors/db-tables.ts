/**
 * DB Table Detector
 *
 * Discovers implicit coupling between files that access the same
 * database tables. Two files with no import relationship might be
 * tightly coupled if they both read/write the same table.
 *
 * Patterns detected:
 *   FROM table_name
 *   INSERT INTO table_name
 *   UPDATE table_name
 *   DELETE FROM table_name
 *   JOIN table_name
 *   INTO table_name (for INSERT INTO)
 *
 * Produces edges of type 'db-table' between files sharing tables.
 * These edges are bidirectional (both files are coupled).
 */

import type { Detector, DetectorContext, DetectedLink } from '../core/types.js'

interface TableAccess {
  file: string
  table: string
  operation: 'read' | 'write'
  line: number
}

export class DbTableDetector implements Detector {
  name = 'db-tables'
  edgeType = 'db-table' as const
  description = 'Implicit coupling via shared database table access'

  async detect(ctx: DetectorContext): Promise<DetectedLink[]> {
    const accesses = await collectTableAccesses(ctx)
    const tableToFiles = groupAccessesByTable(accesses)
    return buildSharedTableEdges(tableToFiles)
  }
}

// SQL patterns to detect table access
const SQL_PATTERNS: ReadonlyArray<{ regex: RegExp; operation: 'read' | 'write' }> = [
  { regex: /\bFROM\s+(\w+)/gi, operation: 'read' },
  { regex: /\bJOIN\s+(\w+)/gi, operation: 'read' },
  { regex: /\bINSERT\s+INTO\s+(\w+)/gi, operation: 'write' },
  { regex: /\bUPDATE\s+(\w+)\s+SET/gi, operation: 'write' },
  { regex: /\bDELETE\s+FROM\s+(\w+)/gi, operation: 'write' },
]

// Known system/meta tables to exclude (+ SQL keyword false-positives)
const EXCLUDE_TABLES = new Set([
  'information_schema', 'pg_catalog', 'pg_tables',
  'set', 'select', 'where', 'and', 'or', 'not',
  'true', 'false', 'null', 'values', 'returning',
])

/** Pour bypasser les fichiers sans aucune SQL signal. */
function hasSqlSignal(content: string): boolean {
  return content.includes('SELECT')
    || content.includes('INSERT')
    || content.includes('UPDATE')
    || content.includes('DELETE')
    || content.includes('query(')
    || content.includes('query`')
}

/** Lit en parallèle les .ts files (I/O fs indépendantes), match séquentiel. */
async function collectTableAccesses(ctx: DetectorContext): Promise<TableAccess[]> {
  const tsFiles = ctx.files.filter((f) => f.endsWith('.ts'))
  const fileContents = await Promise.all(
    tsFiles.map(async (file) => ({ file, content: await ctx.readFile(file) })),
  )
  const accesses: TableAccess[] = []
  for (const { file, content } of fileContents) {
    if (!hasSqlSignal(content)) continue
    extractAccessesFromContent(file, content, accesses)
  }
  return accesses
}

function extractAccessesFromContent(
  file: string,
  content: string,
  accesses: TableAccess[],
): void {
  for (const { regex, operation } of SQL_PATTERNS) {
    // Local regex pour éviter race lastIndex partagé entre fichiers.
    const localRe = new RegExp(regex.source, regex.flags)
    let match: RegExpExecArray | null
    while ((match = localRe.exec(content)) !== null) {
      const tableName = match[1].toLowerCase()
      if (!isLikelyTableName(tableName)) continue
      accesses.push({
        file,
        table: tableName,
        operation,
        line: getLineNumber(content, match.index),
      })
    }
  }
}

function isLikelyTableName(name: string): boolean {
  if (EXCLUDE_TABLES.has(name)) return false
  if (name.startsWith('$')) return false      // SQL parameter
  if (name.length < 2) return false
  if (/^\d/.test(name)) return false          // starts with number
  return true
}

function getLineNumber(content: string, offset: number): number {
  return content.substring(0, offset).split('\n').length
}

function groupAccessesByTable(accesses: TableAccess[]): Map<string, TableAccess[]> {
  const tableToFiles = new Map<string, TableAccess[]>()
  for (const access of accesses) {
    const existing = tableToFiles.get(access.table) || []
    existing.push(access)
    tableToFiles.set(access.table, existing)
  }
  return tableToFiles
}

/**
 * Pour chaque table partagée, génère 1 edge writer → reader (data flows from
 * write to read). Skip si moins de 2 fichiers distincts touchent la table.
 */
function buildSharedTableEdges(tableToFiles: Map<string, TableAccess[]>): DetectedLink[] {
  const links: DetectedLink[] = []
  const seen = new Set<string>()
  for (const [table, fileAccesses] of tableToFiles) {
    const uniqueFiles = [...new Set(fileAccesses.map((a) => a.file))]
    if (uniqueFiles.length < 2) continue
    const writers = fileAccesses.filter((a) => a.operation === 'write')
    const readers = fileAccesses.filter((a) => a.operation === 'read')
    for (const writer of writers) {
      for (const reader of readers) {
        emitWriterReaderEdge(writer, reader, table, seen, links)
      }
    }
  }
  return links
}

function emitWriterReaderEdge(
  writer: TableAccess,
  reader: TableAccess,
  table: string,
  seen: Set<string>,
  links: DetectedLink[],
): void {
  if (writer.file === reader.file) return
  const key = `${writer.file}--db-table--${reader.file}--${table}`
  if (seen.has(key)) return
  seen.add(key)
  links.push({
    from: writer.file,
    to: reader.file,
    type: 'db-table',
    label: `table:${table}`,
    resolved: true,
    line: writer.line,
    meta: {
      table,
      writerFile: writer.file,
      writerLine: writer.line,
      readerFile: reader.file,
      readerLine: reader.line,
    },
  })
}
