// ADR-008
/**
 * DrizzleSchemaDetector — Phase 3 enrichissement (multi-projet).
 *
 * Parse les exports Drizzle ORM `pgTable(...)` pour émettre les MÊMES
 * facts que `sql-schema` (qui parse les `.sql` raw). Permet aux rules
 * Datalog (sql-fk-needs-index, etc.) de fonctionner indifféremment sur
 * projets `.sql` (Sentinel) ou Drizzle (Morovar).
 *
 * Stratégie : si `ctx.results['sql-schema']` existe (= projet hybride
 * avec migrations + Drizzle), MERGE les deux. Sinon retourne juste
 * Drizzle. Le patch helper mappe `'drizzle-schema' → 'sqlSchema'` qui
 * écrase le mapping `'sql-schema' → 'sqlSchema'` par la version mergée
 * (drizzle s'enregistre APRÈS sql-schema dans le registry).
 *
 * factsOnly-eligible (mêmes facts émis que sql-schema).
 */

import type { Detector, DetectorRunContext } from '../detector-registry.js'
import {
  analyzeDrizzleSchema,
  type SqlSchemaResult,
} from '../../extractors/drizzle-schema.js'
import { derivePrimaryKeys } from '../../extractors/sql-schema.js'
import {
  cmpSqlFileLine,
  cmpSqlFromTableColumn,
  cmpSqlTableColumn,
} from '../../extractors/_shared/sql-helpers.js'

export class DrizzleSchemaDetector implements Detector<SqlSchemaResult> {
  readonly name = 'drizzle-schema'
  readonly factsOnlyEligible = true

  async run(ctx: DetectorRunContext): Promise<SqlSchemaResult | undefined> {
    const enabled =
      (ctx.config.detectorOptions?.['drizzleSchema']?.['enabled'] as boolean | undefined) ?? true
    if (!enabled) return undefined

    // Le détecteur Drizzle a besoin de TOUS les fichiers TS du graph
    // pour scanner les pgTable exports. ctx.files contient déjà cette
    // liste (relatifs au rootDir).
    const drizzleResult = await analyzeDrizzleSchema(
      ctx.config.rootDir,
      ctx.files,
      ctx.sharedProject,
    )

    // Si rien de Drizzle dans le projet, on retourne undefined → pas
    // de patch (pas d'écrasement du sql-schema éventuel).
    if (drizzleResult.tables.length === 0) {
      return undefined
    }

    // Merge avec sql-schema si présent (projet hybride raw SQL + Drizzle).
    const sqlResult = ctx.results['sql-schema'] as SqlSchemaResult | undefined
    if (!sqlResult || sqlResult.tables.length === 0) {
      return drizzleResult
    }

    return mergeSqlSchemaResults(sqlResult, drizzleResult)
  }
}

/**
 * Merge deux SqlSchemaResult (raw SQL + Drizzle) en concaténant les
 * arrays. Recalcule fkWithoutIndex sur l'union des indexes (un FK
 * peut être déclaré côté Drizzle mais indexé via une migration .sql,
 * et inversement).
 */
function mergeSqlSchemaResults(
  a: SqlSchemaResult,
  b: SqlSchemaResult,
): SqlSchemaResult {
  const tables = [...a.tables, ...b.tables]
  const indexes = [...a.indexes, ...b.indexes]
  const foreignKeys = [...a.foreignKeys, ...b.foreignKeys]
  const fkWithoutIndex = recomputeFkWithoutIndex(indexes, foreignKeys)

  tables.sort(cmpSqlFileLine)
  indexes.sort(cmpSqlFileLine)
  foreignKeys.sort(cmpSqlFromTableColumn)
  fkWithoutIndex.sort(cmpSqlFromTableColumn)

  // Re-dérive les PK sur l'union (un PK peut venir de l'un ou l'autre).
  const primaryKeys = derivePrimaryKeys(tables, indexes)
  primaryKeys.sort(cmpSqlTableColumn)

  return { tables, indexes, foreignKeys, fkWithoutIndex, primaryKeys }
}

/**
 * Un FK peut être déclaré côté Drizzle mais indexé via une migration .sql
 * (ou inversement). Recalcul sur l'union des indexes.
 */
function recomputeFkWithoutIndex(
  indexes: SqlSchemaResult['indexes'],
  foreignKeys: SqlSchemaResult['foreignKeys'],
): SqlSchemaResult['fkWithoutIndex'] {
  const indexedFirstCol = new Set<string>()
  for (const idx of indexes) {
    if (idx.firstColumn === null) continue
    indexedFirstCol.add(`${idx.table}\x00${idx.firstColumn}`)
  }

  const fkWithoutIndex: SqlSchemaResult['fkWithoutIndex'] = []
  for (const fk of foreignKeys) {
    if (indexedFirstCol.has(`${fk.fromTable}\x00${fk.fromColumn}`)) continue
    fkWithoutIndex.push({
      fromTable: fk.fromTable,
      fromColumn: fk.fromColumn,
      toTable: fk.toTable,
      toColumn: fk.toColumn,
      file: fk.file,
      line: fk.line,
    })
  }
  return fkWithoutIndex
}
