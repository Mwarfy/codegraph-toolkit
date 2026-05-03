/**
 * Drizzle ORM schema extractor — parse les exports `pgTable(...)` pour
 * détecter tables, colonnes, FKs, indexes. Émet **les mêmes types**
 * que `sql-schema.ts` pour qu'une rule Datalog (ex: sql-fk-needs-index)
 * marche indifféremment sur projets `.sql` raw ou Drizzle.
 *
 * Pattern Drizzle reconnu :
 *
 *   export const players = pgTable('players', {
 *     id: uuid('id').primaryKey().defaultRandom(),
 *     username: text('username').notNull().unique(),
 *     ownerId: uuid('owner_id').references(() => owners.id),
 *   }, (table) => ({
 *     usernameIdx: index('username_idx').on(table.username),
 *     uniqEmail:   uniqueIndex('uniq_email').on(table.email),
 *   }));
 *
 * Limites v1 :
 *   - Resolution `.references(() => other.col)` : intra-fichier seulement
 *     (le cas commun pour Drizzle). Cross-file via imports = piège v2.
 *   - Pas de support `.references(otherTable.col)` (sans arrow function) —
 *     pattern non-Drizzle
 *   - FK composites (multi-col references) skip
 *   - Schemas qualifiés (`pgSchema('app').table(...)`) skip — Sentinel
 *     style mono-schema
 *
 * Cf. Phase 3 du plan d'enrichissement (multi-projet).
 */

import { Project, Node, SyntaxKind } from 'ts-morph'
import type {
  SourceFile,
  CallExpression,
  ObjectLiteralExpression,
  PropertyAssignment,
  ArrowFunction,
} from 'ts-morph'
import * as path from 'node:path'
import type {
  SqlTable,
  SqlColumn,
  SqlIndex,
  SqlForeignKey,
  SqlFkWithoutIndex,
  SqlSchemaResult,
} from './sql-schema.js'
import { derivePrimaryKeys } from './sql-schema.js'
import { computeFkWithoutIndex, cmpSqlFileLine, cmpSqlFromTableColumn, cmpSqlTableColumn } from './_shared/sql-helpers.js'

export type { SqlSchemaResult } from './sql-schema.js'

/**
 * Mapping Drizzle column type method → SQL type pour les facts.
 * Default si non listé : on capture le nom de la méthode tel quel.
 */
const DRIZZLE_COLUMN_TYPES = new Set([
  'uuid', 'text', 'varchar', 'integer', 'bigint', 'serial', 'bigserial',
  'boolean', 'timestamp', 'date', 'time', 'jsonb', 'json',
  'real', 'doublePrecision', 'numeric', 'decimal',
  'pgEnum', 'customType',
])

/**
 * Analyze tous les exports Drizzle dans le projet.
 *
 * @param rootDir   Project root (relatif au snapshot)
 * @param files     Liste de fichiers TS relatifs à scanner (typically
 *                  ceux qui contiennent `pgTable` import)
 * @param project   Shared ts-morph Project (réutilisé)
 */
interface DrizzleAggregated {
  tables: SqlTable[]
  indexes: SqlIndex[]
  foreignKeys: SqlForeignKey[]
}

function parseDrizzleFiles(rootDir: string, files: string[], project: Project): DrizzleAggregated {
  const fileSet = new Set(files)
  const tables: SqlTable[] = []
  const indexes: SqlIndex[] = []
  const foreignKeys: SqlForeignKey[] = []
  for (const sf of project.getSourceFiles()) {
    const relPath = relativize(sf.getFilePath(), rootDir)
    if (!relPath || !fileSet.has(relPath)) continue
    const fileResult = parseDrizzleFile(sf, relPath)
    tables.push(...fileResult.tables)
    indexes.push(...fileResult.indexes)
    foreignKeys.push(...fileResult.foreignKeys)
  }
  return { tables, indexes, foreignKeys }
}

export async function analyzeDrizzleSchema(
  rootDir: string,
  files: string[],
  project: Project,
): Promise<SqlSchemaResult> {
  const { tables, indexes, foreignKeys } = parseDrizzleFiles(rootDir, files, project)

  const fkWithoutIndex = computeFkWithoutIndex(foreignKeys, indexes)
  const primaryKeys = derivePrimaryKeys(tables, indexes)

  tables.sort(cmpSqlFileLine)
  indexes.sort(cmpSqlFileLine)
  foreignKeys.sort(cmpSqlFromTableColumn)
  fkWithoutIndex.sort(cmpSqlFromTableColumn)
  primaryKeys.sort(cmpSqlTableColumn)

  return { tables, indexes, foreignKeys, fkWithoutIndex, primaryKeys }
}

/**
 * Parse un seul SourceFile à la recherche de pgTable exports.
 * Retourne tables/indexes/foreignKeys (sans le FK-without-index calc).
 */
interface PgTableCallInfo {
  init: import('ts-morph').CallExpression
  varName: string
  tableName: string
  args: import('ts-morph').Node[]
}

/**
 * Match `const X = pgTable('name', { ... })` et retourne info structurelle
 * partagee entre Pass 1 (varName → tableName map) et Pass 2 (extract cols).
 */
function matchPgTableDecl(decl: import('ts-morph').VariableDeclaration): PgTableCallInfo | null {
  const init = decl.getInitializer()
  if (!init || !Node.isCallExpression(init)) return null
  if (getCalleeName(init) !== 'pgTable') return null
  const args = init.getArguments()
  if (args.length < 2) return null
  const nameArg = args[0]
  if (!Node.isStringLiteral(nameArg)) return null
  return {
    init,
    varName: decl.getName(),
    tableName: nameArg.getLiteralText(),
    args,
  }
}

/**
 * Iterate les variable statements top-level + match pgTable. Le shape est
 * shared entre Pass 1 et Pass 2 — factor en helper.
 */
function* iteratePgTables(sf: SourceFile): Generator<PgTableCallInfo> {
  for (const stmt of sf.getStatements()) {
    if (!Node.isVariableStatement(stmt)) continue
    for (const decl of stmt.getDeclarationList().getDeclarations()) {
      const info = matchPgTableDecl(decl)
      if (info) yield info
    }
  }
}

function emitImplicitColumnIndexes(
  column: SqlColumn,
  tableName: string,
  filePath: string,
  indexes: SqlIndex[],
): void {
  if (column.isPrimaryKey) {
    indexes.push({
      name: `${tableName}_pkey`,
      table: tableName,
      firstColumn: column.name,
      columns: [column.name],
      unique: true,
      implicit: true,
      file: filePath,
      line: column.line,
    })
  } else if (column.isUnique) {
    indexes.push({
      name: `${tableName}_${column.name}_key`,
      table: tableName,
      firstColumn: column.name,
      columns: [column.name],
      unique: true,
      implicit: true,
      file: filePath,
      line: column.line,
    })
  }
}

interface ColumnExtractResult {
  columns: SqlColumn[]
  jsToDbColumn: Map<string, string>
}

function extractColumnsFromObjectLiteral(
  colsArg: import('ts-morph').ObjectLiteralExpression,
  tableName: string,
  filePath: string,
  varNameToTable: Map<string, string>,
  indexes: SqlIndex[],
  foreignKeys: SqlForeignKey[],
): ColumnExtractResult {
  const columns: SqlColumn[] = []
  // Drizzle nomme la prop JS en camelCase mais la column DB en snake_case.
  const jsToDbColumn = new Map<string, string>()
  for (const prop of colsArg.getProperties()) {
    if (!Node.isPropertyAssignment(prop)) continue
    const colInfo = parseColumnProperty(prop, varNameToTable)
    if (!colInfo) continue
    columns.push(colInfo.column)
    const jsName = prop.getName().replace(/^['"]|['"]$/g, '')
    jsToDbColumn.set(jsName, colInfo.column.name)

    if (colInfo.column.foreignKey) {
      foreignKeys.push({
        fromTable: tableName,
        fromColumn: colInfo.column.name,
        toTable: colInfo.column.foreignKey.toTable,
        toColumn: colInfo.column.foreignKey.toColumn,
        file: filePath,
        line: colInfo.column.line,
      })
    }
    emitImplicitColumnIndexes(colInfo.column, tableName, filePath, indexes)
  }
  return { columns, jsToDbColumn }
}

export function parseDrizzleFile(
  sf: SourceFile,
  filePath: string,
): { tables: SqlTable[]; indexes: SqlIndex[]; foreignKeys: SqlForeignKey[] } {
  const tables: SqlTable[] = []
  const indexes: SqlIndex[] = []
  const foreignKeys: SqlForeignKey[] = []

  // Pass 1 : varName → tableName map (intra-fichier) pour resoudre
  // les references Drizzle (`references(() => other.id)`).
  const varNameToTable = new Map<string, string>()
  for (const info of iteratePgTables(sf)) {
    varNameToTable.set(info.varName, info.tableName)
  }

  // Pass 2 : extraire columns + indexes + FKs.
  for (const info of iteratePgTables(sf)) {
    const colsArg = info.args[1]
    if (!Node.isObjectLiteralExpression(colsArg)) continue

    const { columns, jsToDbColumn } = extractColumnsFromObjectLiteral(
      colsArg, info.tableName, filePath, varNameToTable, indexes, foreignKeys,
    )

    tables.push({
      name: info.tableName,
      file: filePath,
      line: info.init.getStartLineNumber(),
      columns,
    })

    // 3e arg (optionnel) : (table) => ({ idx: index('x').on(...) }).
    if (info.args.length >= 3) {
      const indexArg = info.args[2]
      if (Node.isArrowFunction(indexArg)) {
        indexes.push(...parseIndexFunction(indexArg, info.tableName, filePath, jsToDbColumn))
      }
    }
  }

  return { tables, indexes, foreignKeys }
}

/**
 * Parse une property assignment d'un Drizzle column object :
 *   `username: text('username').notNull().unique().references(() => other.id)`
 *
 * Returns { column } ou null si pas reconnu comme column Drizzle.
 */
interface ColumnModifiers {
  notNull: boolean
  isUnique: boolean
  isPrimaryKey: boolean
  foreignKey?: { toTable: string; toColumn: string }
}

/**
 * Resoud `references(() => other.id)` vers `{ toTable, toColumn }`.
 * Returns undefined si shape n'est pas reconnue ou table cible non
 * trouvee dans le map intra-fichier.
 */
function resolveReferencesArg(
  call: import('ts-morph').CallExpression,
  varNameToTable: Map<string, string>,
): { toTable: string; toColumn: string } | undefined {
  const refArgs = call.getArguments()
  if (refArgs.length === 0) return undefined
  const fnArg = refArgs[0]
  if (!Node.isArrowFunction(fnArg)) return undefined
  const body = fnArg.getBody()
  // Body = `players.id` (PropertyAccessExpression)
  if (!Node.isPropertyAccessExpression(body)) return undefined
  const expr = body.getExpression()
  if (!Node.isIdentifier(expr)) return undefined
  const targetTable = varNameToTable.get(expr.getText())
  if (!targetTable) return undefined
  return { toTable: targetTable, toColumn: body.getName() }
}

function collectColumnModifiers(
  chain: import('ts-morph').CallExpression[],
  varNameToTable: Map<string, string>,
): ColumnModifiers {
  const mods: ColumnModifiers = { notNull: false, isUnique: false, isPrimaryKey: false }
  for (const call of chain.slice(1)) {
    const methodName = getCalleeName(call)
    if (methodName === 'notNull') mods.notNull = true
    else if (methodName === 'unique') mods.isUnique = true
    else if (methodName === 'primaryKey') mods.isPrimaryKey = true
    else if (methodName === 'references') {
      mods.foreignKey = resolveReferencesArg(call, varNameToTable)
    }
  }
  return mods
}

function parseColumnProperty(
  prop: PropertyAssignment,
  varNameToTable: Map<string, string>,
): { column: SqlColumn } | null {
  const init = prop.getInitializer()
  if (!init || !Node.isCallExpression(init)) return null

  // Walk la chaine `text('foo').notNull().unique()` : init courant est
  // `unique()`, parent `notNull()`, etc. Le BASE est le premier call.
  const chain = collectCallChain(init)
  if (chain.length === 0) return null

  const baseCall = chain[0]
  const baseName = getCalleeName(baseCall)
  if (!baseName || !DRIZZLE_COLUMN_TYPES.has(baseName)) return null

  const baseArgs = baseCall.getArguments()
  if (baseArgs.length === 0 || !Node.isStringLiteral(baseArgs[0])) return null

  const mods = collectColumnModifiers(chain, varNameToTable)

  return {
    column: {
      name: baseArgs[0].getLiteralText(),
      type: baseName.toUpperCase(),
      notNull: mods.notNull,
      isUnique: mods.isUnique,
      isPrimaryKey: mods.isPrimaryKey,
      foreignKey: mods.foreignKey,
      line: prop.getStartLineNumber(),
    },
  }
}

/**
 * Parse l'arrow function `(table) => ({ idx: index('x').on(table.col) })`
 * et extrait les SqlIndex émis.
 */
/**
 * Le body d'une arrow `(table) => ...` peut etre :
 *   - Block (`{ return { ... } }`)
 *   - ObjectLiteralExpression direct (`({ ... })`)
 *   - ParenthesizedExpression wrapping le object
 */
function getArrowReturnObject(fn: ArrowFunction): ObjectLiteralExpression | null {
  const body = fn.getBody()
  if (Node.isBlock(body)) {
    const retStmt = body.getStatements().find((s) => Node.isReturnStatement(s))
    if (retStmt && Node.isReturnStatement(retStmt)) {
      const expr = retStmt.getExpression()
      if (expr && Node.isObjectLiteralExpression(expr)) return expr
    }
    return null
  }
  if (Node.isObjectLiteralExpression(body)) return body
  if (Node.isParenthesizedExpression(body)) {
    const inner = body.getExpression()
    if (Node.isObjectLiteralExpression(inner)) return inner
  }
  return null
}

interface ParsedIndexCall {
  name: string
  unique: boolean
  cols: string[]
}

/**
 * Parse `index('name').on(table.col1, table.col2)` ou
 * `uniqueIndex('name').on(...)`. Retourne null si shape n'est pas reconnue.
 */
function parseIndexCallChain(
  call: import('ts-morph').CallExpression,
  jsToDbColumn: Map<string, string>,
): ParsedIndexCall | null {
  const chain = collectCallChain(call)
  const baseCall = chain[0]
  const baseName = getCalleeName(baseCall)
  if (baseName !== 'index' && baseName !== 'uniqueIndex') return null

  const baseArgs = baseCall.getArguments()
  if (baseArgs.length === 0 || !Node.isStringLiteral(baseArgs[0])) return null

  const onCall = chain.find((c) => getCalleeName(c) === 'on')
  if (!onCall) return null

  const cols: string[] = []
  for (const arg of onCall.getArguments()) {
    if (Node.isPropertyAccessExpression(arg)) {
      // `table.col` : map camelCase JS → snake_case DB via jsToDbColumn.
      const jsName = arg.getName()
      cols.push(jsToDbColumn.get(jsName) ?? jsName)
    }
  }
  if (cols.length === 0) return null

  return {
    name: baseArgs[0].getLiteralText(),
    unique: baseName === 'uniqueIndex',
    cols,
  }
}

function parseIndexFunction(
  fn: ArrowFunction,
  tableName: string,
  filePath: string,
  jsToDbColumn: Map<string, string>,
): SqlIndex[] {
  const out: SqlIndex[] = []
  const obj = getArrowReturnObject(fn)
  if (!obj) return out

  for (const prop of obj.getProperties()) {
    if (!Node.isPropertyAssignment(prop)) continue
    const init = prop.getInitializer()
    if (!init || !Node.isCallExpression(init)) continue
    const parsed = parseIndexCallChain(init, jsToDbColumn)
    if (!parsed) continue

    out.push({
      name: parsed.name,
      table: tableName,
      firstColumn: parsed.cols[0],
      columns: parsed.cols,
      unique: parsed.unique,
      implicit: false,
      file: filePath,
      line: prop.getStartLineNumber(),
    })
  }

  return out
}

/**
 * Collecte la chaîne de call expressions du plus profond (base) au
 * plus extérieur. Ex: `a().b().c()` → [a(), b(), c()].
 */
function collectCallChain(call: CallExpression): CallExpression[] {
  const chain: CallExpression[] = []
  let current: Node | undefined = call
  while (current && Node.isCallExpression(current)) {
    chain.unshift(current)
    const expr = current.getExpression()
    if (Node.isPropertyAccessExpression(expr)) {
      current = expr.getExpression()
    } else {
      break
    }
  }
  return chain
}

/**
 * Pour un CallExpression, retourne le nom de la méthode/fonction
 * appelée. Ex: `text('foo')` → `'text'`, `obj.notNull()` → `'notNull'`.
 */
function getCalleeName(call: CallExpression): string | null {
  const expr = call.getExpression()
  if (Node.isIdentifier(expr)) return expr.getText()
  if (Node.isPropertyAccessExpression(expr)) return expr.getName()
  return null
}

function relativize(absPath: string, rootDir: string): string {
  return path.relative(rootDir, absPath).replace(/\\/g, '/')
}

