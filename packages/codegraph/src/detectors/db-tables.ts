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
    const accesses: TableAccess[] = []

    // SQL patterns to detect table access
    const patterns: Array<{ regex: RegExp; operation: 'read' | 'write' }> = [
      { regex: /\bFROM\s+(\w+)/gi, operation: 'read' },
      { regex: /\bJOIN\s+(\w+)/gi, operation: 'read' },
      { regex: /\bINSERT\s+INTO\s+(\w+)/gi, operation: 'write' },
      { regex: /\bUPDATE\s+(\w+)\s+SET/gi, operation: 'write' },
      { regex: /\bDELETE\s+FROM\s+(\w+)/gi, operation: 'write' },
    ]

    // Known system/meta tables to exclude
    const excludeTables = new Set([
      'information_schema', 'pg_catalog', 'pg_tables',
      'set', 'select', 'where', 'and', 'or', 'not',
      'true', 'false', 'null', 'values', 'returning',
    ])

    // Lit en parallèle les .ts files (I/O fs indépendantes), match séquentiel.
    const tsFiles = ctx.files.filter((f) => f.endsWith('.ts'))
    const fileContents = await Promise.all(
      tsFiles.map(async (file) => ({ file, content: await ctx.readFile(file) })),
    )
    for (const { file, content } of fileContents) {
      // Only scan files that contain SQL-like patterns
      if (!content.includes('SELECT') && !content.includes('INSERT') &&
          !content.includes('UPDATE') && !content.includes('DELETE') &&
          !content.includes('query(') && !content.includes('query`')) {
        continue
      }

      for (const { regex, operation } of patterns) {
        // Local regex pour éviter race lastIndex partagé entre fichiers.
        const localRe = new RegExp(regex.source, regex.flags)
        let match: RegExpExecArray | null
        while ((match = localRe.exec(content)) !== null) {
          const tableName = match[1].toLowerCase()

          // Filter out non-table matches
          if (excludeTables.has(tableName)) continue
          if (tableName.startsWith('$')) continue // SQL parameter
          if (tableName.length < 2) continue
          if (/^\d/.test(tableName)) continue // starts with number

          accesses.push({
            file,
            table: tableName,
            operation,
            line: this.getLineNumber(content, match.index),
          })
        }
      }
    }

    // Group accesses by table
    const tableToFiles = new Map<string, TableAccess[]>()
    for (const access of accesses) {
      const existing = tableToFiles.get(access.table) || []
      existing.push(access)
      tableToFiles.set(access.table, existing)
    }

    // Create edges between files that share a table
    const links: DetectedLink[] = []
    const seen = new Set<string>()

    for (const [table, fileAccesses] of tableToFiles) {
      // Get unique files accessing this table
      const uniqueFiles = [...new Set(fileAccesses.map(a => a.file))]

      if (uniqueFiles.length < 2) continue // only coupled if 2+ files touch it

      // Create edges: writers → readers (data flows from write to read)
      const writers = fileAccesses.filter(a => a.operation === 'write')
      const readers = fileAccesses.filter(a => a.operation === 'read')

      for (const writer of writers) {
        for (const reader of readers) {
          if (writer.file === reader.file) continue

          const key = `${writer.file}--db-table--${reader.file}--${table}`
          if (seen.has(key)) continue
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
      }
    }

    return links
  }

  private getLineNumber(content: string, offset: number): number {
    return content.substring(0, offset).split('\n').length
  }
}
