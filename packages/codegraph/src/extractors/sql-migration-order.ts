/**
 * SQL Migration Order — détecteur déterministe (Phase 4 Tier 5).
 *
 * Vérifie que pour chaque foreign key, la migration qui le crée vient
 * APRÈS (numérique) la migration qui crée la table cible. Pattern
 * topological sort lite : violation = migration N déclare un FK vers
 * une table créée en migration N+1 (forward reference).
 *
 * Pourquoi : Postgres applique les migrations dans l'ordre. Un FK
 * déclaré avant la table cible plante au déploiement avec
 * "relation 'X' does not exist". Détectable AVANT le push prod.
 *
 * Stratégie :
 *   1. Extraire le numéro de chaque migration depuis son file path
 *      (convention `NNN_xxx.sql` ou `NNNN_xxx.sql`).
 *   2. Pour chaque table : noter dans quelle migration elle est créée
 *      (premier file alphabétiquement = première chronologiquement).
 *   3. Pour chaque FK : check que la migration du FK >= migration de
 *      la table cible.
 *
 * Skip si pas de pattern numéroté détectable (projets sans
 * versionning de migrations explicite).
 */

export interface MigrationOrderViolation {
  /** File de la migration qui déclare le FK trop tôt. */
  file: string
  line: number
  fromTable: string
  fromColumn: string
  toTable: string
  /** Numéro extrait de la migration qui DÉCLARE le FK. */
  fkMigrationNumber: number
  /** Numéro extrait de la migration qui CRÉE la table cible. */
  targetMigrationNumber: number
}

interface SqlSchema {
  tables: Array<{ name: string; file: string; line: number }>
  foreignKeys: Array<{
    fromTable: string
    fromColumn: string
    toTable: string
    file: string
    line: number
  }>
}

// Pattern de nommage classique : `NNN_xxx.sql`, `NNNN_xxx.sql`.
// Capture le numéro en début de basename. Exemples :
//   001_initial_schema.sql → 1
//   050_video_metrics.sql  → 50
//   20240115_users.sql     → 20240115 (date-based)
const MIGRATION_NUMBER_RE = /(?:^|\/)(\d+)[_-]/

function extractMigrationNumber(file: string): number | null {
  const m = file.match(MIGRATION_NUMBER_RE)
  if (!m) return null
  return parseInt(m[1], 10)
}

export function findMigrationOrderViolations(
  schema: SqlSchema,
): MigrationOrderViolation[] {
  const violations: MigrationOrderViolation[] = []

  // Build : table → migration number où elle est créée.
  // Si une table apparaît dans plusieurs files (rare — recreate /
  // alter complexe), on prend le PREMIER (ordre numérique).
  const tableFirstMigration = new Map<string, number>()
  for (const table of schema.tables) {
    const num = extractMigrationNumber(table.file)
    if (num === null) continue
    const existing = tableFirstMigration.get(table.name)
    if (existing === undefined || num < existing) {
      tableFirstMigration.set(table.name, num)
    }
  }

  // Pour chaque FK : extract num du file qui déclare le FK, compare
  // avec num de la table cible.
  for (const fk of schema.foreignKeys) {
    const fkMigNum = extractMigrationNumber(fk.file)
    if (fkMigNum === null) continue
    const targetMigNum = tableFirstMigration.get(fk.toTable)
    if (targetMigNum === undefined) continue   // table cible non versionnée — skip
    if (fkMigNum < targetMigNum) {
      violations.push({
        file: fk.file,
        line: fk.line,
        fromTable: fk.fromTable,
        fromColumn: fk.fromColumn,
        toTable: fk.toTable,
        fkMigrationNumber: fkMigNum,
        targetMigrationNumber: targetMigNum,
      })
    }
  }

  // Tri stable : par file → line.
  violations.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    return a.line - b.line
  })
  return violations
}
