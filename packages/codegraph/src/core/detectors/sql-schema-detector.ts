// ADR-008
/**
 * SqlSchemaDetector — Phase 2 enrichissement.
 *
 * Parse les migrations Postgres pour détecter tables, indexes, FKs.
 * Émet `SqlFkWithoutIndex` quand un FK n'a pas d'index correspondant
 * (= DELETE CASCADE en full scan, perf disaster prod).
 *
 * factsOnly-eligible : utilisé pour les facts Datalog
 * (SqlTable/SqlColumn/SqlForeignKey/SqlIndex/SqlFkWithoutIndex).
 *
 * Pas de dépendance inter-détecteurs : I/O fichier seul, pas de
 * sharedProject ts-morph requis.
 */

import type { Detector, DetectorRunContext } from '../detector-registry.js'
import {
  analyzeSqlSchema,
  type SqlSchemaResult,
} from '../../extractors/sql-schema.js'

export class SqlSchemaDetector implements Detector<SqlSchemaResult> {
  readonly name = 'sql-schema'
  readonly factsOnlyEligible = true

  async run(ctx: DetectorRunContext): Promise<SqlSchemaResult | undefined> {
    const enabled =
      (ctx.config.detectorOptions?.['sqlSchema']?.['enabled'] as boolean | undefined) ?? true
    if (!enabled) return undefined

    const opts = ctx.config.detectorOptions?.['sqlSchema'] ?? {}
    const globs = (opts['globs'] as string[] | undefined) ?? ['**/*.sql']
    return await analyzeSqlSchema(ctx.config.rootDir, globs)
  }
}
