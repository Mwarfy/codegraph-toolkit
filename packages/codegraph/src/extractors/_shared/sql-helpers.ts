/**
 * SQL schema helpers partagés entre extracteurs sql-schema et drizzle-schema
 * (NCD = 41 entre les 2 originaux). Le calcul de FK-sans-index est
 * l'invariant fondamental capté par la rule sql-fk-needs-index.
 */

// Import depuis sql-types.ts (no cycle) au lieu de sql-schema.ts.
// Cycle direct sql-helpers ↔ sql-schema cassé via extraction des types.
import type { SqlForeignKey, SqlIndex, SqlFkWithoutIndex } from './sql-types.js'

/**
 * Calcule l'ensemble des FK sans index correspondant sur leur source
 * column. Implémentation O(F + I) via un Set des `table\x00firstCol`
 * indexés. Critique pour la rule sql-fk-needs-index — révèle les
 * DELETE CASCADE qui dégénèrent en full scan.
 */
export function computeFkWithoutIndex(
  foreignKeys: SqlForeignKey[],
  indexes: SqlIndex[],
): SqlFkWithoutIndex[] {
  // Build index : (table, firstCol) → at least one index exists
  const indexedFirstCol = new Set<string>()
  for (const idx of indexes) {
    if (idx.firstColumn === null) continue
    indexedFirstCol.add(`${idx.table}\x00${idx.firstColumn}`)
  }

  const out: SqlFkWithoutIndex[] = []
  for (const fk of foreignKeys) {
    const key = `${fk.fromTable}\x00${fk.fromColumn}`
    if (!indexedFirstCol.has(key)) {
      out.push({
        fromTable: fk.fromTable,
        fromColumn: fk.fromColumn,
        toTable: fk.toTable,
        toColumn: fk.toColumn,
        file: fk.file,
        line: fk.line,
      })
    }
  }
  return out
}
