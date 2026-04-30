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

  // Recalcul fkWithoutIndex sur l'union
  const indexedFirstCol = new Set<string>()
  for (const idx of indexes) {
    if (idx.firstColumn === null) continue
    indexedFirstCol.add(`${idx.table}\x00${idx.firstColumn}`)
  }

  const fkWithoutIndex: typeof a.fkWithoutIndex = []
  for (const fk of foreignKeys) {
    const key = `${fk.fromTable}\x00${fk.fromColumn}`
    if (!indexedFirstCol.has(key)) {
      fkWithoutIndex.push({
        fromTable: fk.fromTable,
        fromColumn: fk.fromColumn,
        toTable: fk.toTable,
        toColumn: fk.toColumn,
        file: fk.file,
        line: fk.line,
      })
    }
  }

  // Tri stable comme dans les analyzers
  tables.sort((x, y) => x.file < y.file ? -1 : x.file > y.file ? 1 : x.line - y.line)
  indexes.sort((x, y) => x.file < y.file ? -1 : x.file > y.file ? 1 : x.line - y.line)
  foreignKeys.sort((x, y) =>
    x.fromTable < y.fromTable ? -1 : x.fromTable > y.fromTable ? 1 :
    x.fromColumn < y.fromColumn ? -1 : x.fromColumn > y.fromColumn ? 1 : 0)
  fkWithoutIndex.sort((x, y) =>
    x.fromTable < y.fromTable ? -1 : x.fromTable > y.fromTable ? 1 :
    x.fromColumn < y.fromColumn ? -1 : x.fromColumn > y.fromColumn ? 1 : 0)

  // Re-dérive les PK sur l'union (un PK peut venir de l'un ou l'autre).
  const primaryKeys = derivePrimaryKeys(tables, indexes)
  primaryKeys.sort((x, y) =>
    x.table < y.table ? -1 : x.table > y.table ? 1 :
    x.column < y.column ? -1 : x.column > y.column ? 1 : 0)

  return { tables, indexes, foreignKeys, fkWithoutIndex, primaryKeys }
}
