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
export async function analyzeDrizzleSchema(
  rootDir: string,
  files: string[],
  project: Project,
): Promise<SqlSchemaResult> {
  const tables: SqlTable[] = []
  const indexes: SqlIndex[] = []
  const foreignKeys: SqlForeignKey[] = []

  // Map identifier (varName) → table name in DB. Permet de résoudre
  // `references(() => players.id)` quand `players` est `pgTable('players', ...)`.
  // Construit en first-pass file-par-file. Pour cross-file ref, on devra
  // étendre v2.
  const fileSet = new Set(files)

  for (const sf of project.getSourceFiles()) {
    const relPath = relativize(sf.getFilePath(), rootDir)
    if (!relPath || !fileSet.has(relPath)) continue
    const fileResult = parseDrizzleFile(sf, relPath)
    tables.push(...fileResult.tables)
    indexes.push(...fileResult.indexes)
    foreignKeys.push(...fileResult.foreignKeys)
  }

  const fkWithoutIndex = computeFkWithoutIndex(foreignKeys, indexes)
  const primaryKeys = derivePrimaryKeys(tables, indexes)

  // Tri stable
  tables.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line)
  indexes.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line)
  foreignKeys.sort((a, b) =>
    a.fromTable < b.fromTable ? -1 : a.fromTable > b.fromTable ? 1 :
    a.fromColumn < b.fromColumn ? -1 : a.fromColumn > b.fromColumn ? 1 : 0)
  fkWithoutIndex.sort((a, b) =>
    a.fromTable < b.fromTable ? -1 : a.fromTable > b.fromTable ? 1 :
    a.fromColumn < b.fromColumn ? -1 : a.fromColumn > b.fromColumn ? 1 : 0)
  primaryKeys.sort((a, b) =>
    a.table < b.table ? -1 : a.table > b.table ? 1 :
    a.column < b.column ? -1 : a.column > b.column ? 1 : 0)

  return { tables, indexes, foreignKeys, fkWithoutIndex, primaryKeys }
}

/**
 * Parse un seul SourceFile à la recherche de pgTable exports.
 * Retourne tables/indexes/foreignKeys (sans le FK-without-index calc).
 */
export function parseDrizzleFile(
  sf: SourceFile,
  filePath: string,
): { tables: SqlTable[]; indexes: SqlIndex[]; foreignKeys: SqlForeignKey[] } {
  const tables: SqlTable[] = []
  const indexes: SqlIndex[] = []
  const foreignKeys: SqlForeignKey[] = []

  // Map varName → table name (intra-fichier) pour résoudre les references
  const varNameToTable = new Map<string, string>()

  // Pass 1 : collecter les tables (varName → tableName)
  for (const stmt of sf.getStatements()) {
    if (!Node.isVariableStatement(stmt)) continue
    for (const decl of stmt.getDeclarationList().getDeclarations()) {
      const init = decl.getInitializer()
      if (!init || !Node.isCallExpression(init)) continue
      if (getCalleeName(init) !== 'pgTable') continue
      const args = init.getArguments()
      if (args.length < 2) continue
      const nameArg = args[0]
      if (!Node.isStringLiteral(nameArg)) continue
      const tableName = nameArg.getLiteralText()
      const varName = decl.getName()
      varNameToTable.set(varName, tableName)
    }
  }

  // Pass 2 : extraire les colonnes + indexes + FKs
  for (const stmt of sf.getStatements()) {
    if (!Node.isVariableStatement(stmt)) continue
    for (const decl of stmt.getDeclarationList().getDeclarations()) {
      const init = decl.getInitializer()
      if (!init || !Node.isCallExpression(init)) continue
      if (getCalleeName(init) !== 'pgTable') continue
      const args = init.getArguments()
      if (args.length < 2) continue
      const nameArg = args[0]
      if (!Node.isStringLiteral(nameArg)) continue
      const tableName = nameArg.getLiteralText()
      const tableLine = init.getStartLineNumber()

      // 2e arg : object literal des colonnes
      const colsArg = args[1]
      if (!Node.isObjectLiteralExpression(colsArg)) continue

      const columns: SqlColumn[] = []
      // Mapping jsPropName → dbColumnName pour résoudre `table.<jsName>`
      // dans les calls d'index (pass 3). Drizzle nomme la prop JS en
      // camelCase mais la column DB en snake_case souvent.
      const jsToDbColumn = new Map<string, string>()
      for (const prop of colsArg.getProperties()) {
        if (!Node.isPropertyAssignment(prop)) continue
        const colInfo = parseColumnProperty(prop, varNameToTable)
        if (!colInfo) continue
        columns.push(colInfo.column)
        // Capture le nom JS de la propriété pour le mapping
        const jsName = prop.getName().replace(/^['"]|['"]$/g, '')
        jsToDbColumn.set(jsName, colInfo.column.name)

        // Émet FK + index implicite si présent
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
        if (colInfo.column.isPrimaryKey) {
          indexes.push({
            name: `${tableName}_pkey`,
            table: tableName,
            firstColumn: colInfo.column.name,
            columns: [colInfo.column.name],
            unique: true,
            implicit: true,
            file: filePath,
            line: colInfo.column.line,
          })
        } else if (colInfo.column.isUnique) {
          indexes.push({
            name: `${tableName}_${colInfo.column.name}_key`,
            table: tableName,
            firstColumn: colInfo.column.name,
            columns: [colInfo.column.name],
            unique: true,
            implicit: true,
            file: filePath,
            line: colInfo.column.line,
          })
        }
      }

      tables.push({ name: tableName, file: filePath, line: tableLine, columns })

      // 3e arg (optionnel) : (table) => ({ idx: index('x').on(...) })
      if (args.length >= 3) {
        const indexArg = args[2]
        if (Node.isArrowFunction(indexArg)) {
          const indexResults = parseIndexFunction(indexArg, tableName, filePath, jsToDbColumn)
          indexes.push(...indexResults)
        }
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
function parseColumnProperty(
  prop: PropertyAssignment,
  varNameToTable: Map<string, string>,
): { column: SqlColumn } | null {
  const init = prop.getInitializer()
  if (!init || !Node.isCallExpression(init)) return null

  // Walk up la chaîne de méthodes : on a `text('foo').notNull().unique()`
  // L'init courant est `unique()`, son parent est `notNull()`, etc.
  // Pour simplifier : on collecte tous les call names + le BASE call.
  const chain = collectCallChain(init)
  if (chain.length === 0) return null

  // Le BASE est le premier call (le plus profond) : `text('foo')`,
  // `uuid('foo')`, etc.
  const baseCall = chain[0]
  const baseName = getCalleeName(baseCall)
  if (!baseName || !DRIZZLE_COLUMN_TYPES.has(baseName)) return null

  const baseArgs = baseCall.getArguments()
  if (baseArgs.length === 0 || !Node.isStringLiteral(baseArgs[0])) return null
  const dbColumnName = baseArgs[0].getLiteralText()
  const sqlType = baseName.toUpperCase() // simple mapping

  let notNull = false
  let isUnique = false
  let isPrimaryKey = false
  let foreignKey: { toTable: string; toColumn: string } | undefined

  for (const call of chain.slice(1)) {
    const methodName = getCalleeName(call)
    if (methodName === 'notNull') notNull = true
    else if (methodName === 'unique') isUnique = true
    else if (methodName === 'primaryKey') isPrimaryKey = true
    else if (methodName === 'references') {
      const refArgs = call.getArguments()
      if (refArgs.length === 0) continue
      const fnArg = refArgs[0]
      if (Node.isArrowFunction(fnArg)) {
        const body = fnArg.getBody()
        // Body = `players.id` (PropertyAccessExpression)
        if (Node.isPropertyAccessExpression(body)) {
          const expr = body.getExpression()
          if (Node.isIdentifier(expr)) {
            const varName = expr.getText()
            const targetTable = varNameToTable.get(varName)
            if (targetTable) {
              foreignKey = {
                toTable: targetTable,
                toColumn: body.getName(),
              }
            }
          }
        }
      }
    }
  }

  return {
    column: {
      name: dbColumnName,
      type: sqlType,
      notNull,
      isUnique,
      isPrimaryKey,
      foreignKey,
      line: prop.getStartLineNumber(),
    },
  }
}

/**
 * Parse l'arrow function `(table) => ({ idx: index('x').on(table.col) })`
 * et extrait les SqlIndex émis.
 */
function parseIndexFunction(
  fn: ArrowFunction,
  tableName: string,
  filePath: string,
  jsToDbColumn: Map<string, string>,
): SqlIndex[] {
  const out: SqlIndex[] = []
  const body = fn.getBody()

  // body peut être :
  //   - Block (`(table) => { return { ... } }`)
  //   - Direct ObjectLiteralExpression (`(table) => ({ ... })`)
  //   - ParenthesizedExpression wrapping the object
  let obj: ObjectLiteralExpression | null = null
  if (Node.isBlock(body)) {
    // Cherche `return { ... }`
    const retStmt = body.getStatements().find((s) => Node.isReturnStatement(s))
    if (retStmt && Node.isReturnStatement(retStmt)) {
      const expr = retStmt.getExpression()
      if (expr && Node.isObjectLiteralExpression(expr)) obj = expr
    }
  } else if (Node.isObjectLiteralExpression(body)) {
    obj = body
  } else if (Node.isParenthesizedExpression(body)) {
    const inner = body.getExpression()
    if (Node.isObjectLiteralExpression(inner)) obj = inner
  }

  if (!obj) return out

  for (const prop of obj.getProperties()) {
    if (!Node.isPropertyAssignment(prop)) continue
    const init = prop.getInitializer()
    if (!init || !Node.isCallExpression(init)) continue

    const chain = collectCallChain(init)
    // Cherche un baseCall = `index('name')` ou `uniqueIndex('name')`
    const baseCall = chain[0]
    const baseName = getCalleeName(baseCall)
    if (baseName !== 'index' && baseName !== 'uniqueIndex') continue
    const isUnique = baseName === 'uniqueIndex'

    const baseArgs = baseCall.getArguments()
    if (baseArgs.length === 0 || !Node.isStringLiteral(baseArgs[0])) continue
    const indexName = baseArgs[0].getLiteralText()

    // Cherche le call `.on(table.col1, table.col2, ...)` dans le chain
    const onCall = chain.find((c) => getCalleeName(c) === 'on')
    if (!onCall) continue

    const onArgs = onCall.getArguments()
    const cols: string[] = []
    for (const arg of onArgs) {
      if (Node.isPropertyAccessExpression(arg)) {
        // `table.col` → on prend le name JS `col`, puis on le mappe au
        // nom DB via jsToDbColumn (pour gérer le camelCase JS →
        // snake_case DB de Drizzle).
        const jsName = arg.getName()
        cols.push(jsToDbColumn.get(jsName) ?? jsName)
      }
    }
    if (cols.length === 0) continue

    out.push({
      name: indexName,
      table: tableName,
      firstColumn: cols[0],
      columns: cols,
      unique: isUnique,
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

function computeFkWithoutIndex(
  foreignKeys: SqlForeignKey[],
  indexes: SqlIndex[],
): SqlFkWithoutIndex[] {
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
