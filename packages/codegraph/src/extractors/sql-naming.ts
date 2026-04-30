/**
 * SQL Naming Convention — détecteur déterministe (Phase 4 Tier 5).
 *
 * Conventions Postgres / Codd-era classiques :
 *   - Tables / colonnes en snake_case (pas camelCase ni PascalCase)
 *   - Colonnes timestamps suffixées `_at` (created_at, updated_at,
 *     deleted_at, processed_at, …)
 *   - Foreign key columns suffixées `_id` (user_id, project_id, …)
 *
 * Sentinel utilise déjà ces conventions partout — l'invariant est
 * exécutable plutôt qu'implicite. Pour de nouveaux projets : skip
 * dans la convention si tu utilises camelCase.
 *
 * Source : `snapshot.sqlSchema` déjà émis par `sql-schema` ou
 * `drizzle-schema`. Pas de scan AST nouveau.
 *
 * Convention exempt : pas de syntax `// sql-naming-ok` côté SQL —
 * grandfather via la rule Datalog (`SqlNamingGrandfathered`).
 */

export type SqlNamingViolationKind =
  | 'table-not-snake-case'
  | 'column-not-snake-case'
  | 'timestamp-missing-at-suffix'
  | 'fk-missing-id-suffix'

export interface SqlNamingViolation {
  kind: SqlNamingViolationKind
  table: string
  /** Vide pour les violations de table-name. */
  column: string
  file: string
  line: number
}

interface SqlSchema {
  tables: Array<{
    name: string
    file: string
    line: number
    columns: Array<{
      name: string
      type: string
      line: number
    }>
  }>
  foreignKeys: Array<{
    fromTable: string
    fromColumn: string
    file: string
    line: number
  }>
}

// Snake_case : lowercase letters + digits + underscores. Doit commencer
// par une lettre. Pas de double underscore consécutif (style debat,
// mais Postgres convention).
const SNAKE_CASE_RE = /^[a-z][a-z0-9_]*$/

// Types Postgres qui sont temporels — devraient toujours finir par `_at`.
// On reste large : timestamp, timestamptz, date, time. NOT le `interval`
// (= durée, pas un instant).
const TEMPORAL_TYPE_RE = /^(timestamp|timestamptz|date|time)(\s|$)/i

export function findSqlNamingViolations(
  schema: SqlSchema,
): SqlNamingViolation[] {
  const violations: SqlNamingViolation[] = []
  const fkSet = new Set<string>()
  for (const fk of schema.foreignKeys) {
    fkSet.add(fk.fromTable + '\x00' + fk.fromColumn)
  }

  for (const table of schema.tables) {
    // Table name — snake_case.
    if (!SNAKE_CASE_RE.test(table.name)) {
      violations.push({
        kind: 'table-not-snake-case',
        table: table.name,
        column: '',
        file: table.file,
        line: table.line,
      })
    }

    for (const col of table.columns) {
      // Column name — snake_case.
      if (!SNAKE_CASE_RE.test(col.name)) {
        violations.push({
          kind: 'column-not-snake-case',
          table: table.name,
          column: col.name,
          file: table.file,
          line: col.line,
        })
        continue   // skip les autres checks si le nom est déjà cassé
      }

      // Timestamp / temporal column — suffix `_at`.
      if (TEMPORAL_TYPE_RE.test(col.type) && !col.name.endsWith('_at')) {
        // Skip les patterns volontaires : `*_date`, `*_time` (alternatives
        // sémantiques explicites — dob, birth_date, etc.).
        if (!col.name.endsWith('_date') && !col.name.endsWith('_time')) {
          violations.push({
            kind: 'timestamp-missing-at-suffix',
            table: table.name,
            column: col.name,
            file: table.file,
            line: col.line,
          })
        }
      }

      // FK column — suffix `_id`.
      if (fkSet.has(table.name + '\x00' + col.name) && !col.name.endsWith('_id')) {
        violations.push({
          kind: 'fk-missing-id-suffix',
          table: table.name,
          column: col.name,
          file: table.file,
          line: col.line,
        })
      }
    }
  }

  // Tri stable.
  violations.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    if (a.line !== b.line) return a.line - b.line
    return a.kind < b.kind ? -1 : 1
  })
  return violations
}
