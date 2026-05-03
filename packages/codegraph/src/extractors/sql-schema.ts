// ADR-005
/**
 * SQL schema extractor — parse les migrations Postgres pour détecter
 * tables, colonnes, FKs, indexes. Émet `SqlFkWithoutIndex[]` quand un
 * FK n'a pas d'index correspondant (= DELETE CASCADE en full scan).
 *
 * Approche : regex robuste, pattern des migrations Sentinel-style.
 * Pas de tree-sitter (overkill — cf. docs/PHASE-2-SQL-DETECTOR-PLAN.md).
 *
 * Timeline DROP/RENAME/ADD :
 *   - CREATE TABLE → ajoute table
 *   - ALTER ADD COLUMN → ajoute col à toutes les entrées matchant le nom
 *   - ALTER RENAME COLUMN → renomme col (après ADD merge)
 *   - DROP TABLE → retire la table SI elle n'apparaît dans aucun fichier
 *     `schema.sql` post-pivot. Permet de retirer les tables dropping en
 *     migration N (ex: dropshipping mig 039) sans tirer les FP.
 *
 * Rollback files (`db/rollbacks/`) sont exclus par défaut — ce sont des
 * scripts d'urgence, pas le canonical schema. Override via opts.includeRollbacks.
 *
 * Limitations connues v1 :
 *   - FK composites (multi-col) non supportées
 *   - Index sur expression (CREATE INDEX ... ON foo(lower(col))) skip
 *
 * Cf. axe Phase 2 du plan d'enrichissement.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { minimatch } from 'minimatch'
import { computeFkWithoutIndex } from './_shared/sql-helpers.js'

// ═════════════════════════════════════════════════════════════════════
// Types
// ═════════════════════════════════════════════════════════════════════

export interface SqlColumn {
  name: string
  type: string
  notNull: boolean
  isUnique: boolean
  isPrimaryKey: boolean
  /** Référence FK inline si présente. */
  foreignKey?: { toTable: string; toColumn: string }
  line: number
}

export interface SqlTable {
  name: string
  file: string
  line: number
  columns: SqlColumn[]
}

// Types canoniques extraits dans `_shared/sql-types.ts` pour casser le
// cycle direct sql-helpers ↔ sql-schema (CYCLE détecté par codegraph
// statique). Import + re-export pour préserver l'API publique existante
// ET permettre l'usage local des types dans ce fichier.
import type { SqlIndex, SqlForeignKey, SqlFkWithoutIndex } from './_shared/sql-types.js'
export type { SqlIndex, SqlForeignKey, SqlFkWithoutIndex }

/**
 * Une primary key column. Pour les PK composites table-level
 * `PRIMARY KEY (a, b)`, on émet UNE entrée par column (plus joinable
 * côté Datalog que une ligne avec liste).
 */
export interface SqlPrimaryKey {
  table: string
  column: string
  file: string
  line: number
}

export interface SqlSchemaResult {
  tables: SqlTable[]
  indexes: SqlIndex[]
  foreignKeys: SqlForeignKey[]
  fkWithoutIndex: SqlFkWithoutIndex[]
  primaryKeys: SqlPrimaryKey[]
}

/**
 * Internal helper type for ALTER TABLE DROP TABLE tracking.
 * Une table droppée sera exclue du résultat final SAUF si une migration
 * ultérieure (numéro plus élevé) ou `schema.sql` la re-crée.
 */
interface DroppedTable {
  table: string
  file: string
  line: number
}

// ═════════════════════════════════════════════════════════════════════
// Discovery
// ═════════════════════════════════════════════════════════════════════

const DEFAULT_GLOBS = ['**/*.sql']
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next',
  'coverage', '.turbo', '.cache', 'docker-data',
  // Rollback scripts re-créent les tables droppées — c'est de la
  // recovery, pas du canonical schema. Skip par défaut sinon les
  // rules sql-naming/sql-audit-columns flagent des FP sur tables
  // mortes (cf. mig 039 dropshipping cleanup).
  'rollbacks',
])

async function discoverSqlFiles(rootDir: string, globs: string[]): Promise<string[]> {
  const files: string[] = []
  await walk(rootDir, rootDir, files)
  return files
    .filter((f) => globs.some((g) => minimatch(f, g)))
    .sort()
}

async function walk(dir: string, rootDir: string, acc: string[]): Promise<void> {
  const dirName = path.basename(dir)
  if (SKIP_DIRS.has(dirName) && dir !== rootDir) return
  let entries
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      await walk(full, rootDir, acc)
    } else if (e.isFile() && e.name.endsWith('.sql')) {
      acc.push(path.relative(rootDir, full).replace(/\\/g, '/'))
    }
  }
}

// ═════════════════════════════════════════════════════════════════════
// Public API
// ═════════════════════════════════════════════════════════════════════

export async function analyzeSqlSchema(
  rootDir: string,
  globs: string[] = DEFAULT_GLOBS,
): Promise<SqlSchemaResult> {
  const sqlFiles = await discoverSqlFiles(rootDir, globs)

  const tables: SqlTable[] = []
  const indexes: SqlIndex[] = []
  const foreignKeys: SqlForeignKey[] = []
  const addedColumns: AddedColumn[] = []
  const renamedColumns: RenamedColumn[] = []
  const droppedTables: DroppedTable[] = []

  for (const file of sqlFiles) {
    let content: string
    try { content = await fs.readFile(path.join(rootDir, file), 'utf-8') } catch { continue }
    const fileResult = parseSqlFile(content, file)
    tables.push(...fileResult.tables)
    indexes.push(...fileResult.indexes)
    foreignKeys.push(...fileResult.foreignKeys)
    addedColumns.push(...fileResult.addedColumns)
    renamedColumns.push(...fileResult.renamedColumns)
    droppedTables.push(...fileResult.droppedTables)
  }

  // Timeline DROP TABLE : retire les tables droppées du résultat final.
  // Heuristique : une table est considérée "réellement droppée" si elle
  // n'apparaît PAS dans `schema.sql` (canonical post-state). Si schema.sql
  // la contient, c'est qu'elle a été re-créée OU droppée par accident
  // historique mais re-existe — on garde.
  //
  // Rationale : `db/schema.sql` est typiquement régénéré post-migrations
  // comme snapshot du schema courant. C'est notre source de vérité pour
  // "ce qui existe en prod" vs "ce qui a existé un jour".
  if (droppedTables.length > 0) {
    // Match basename exact `schema.sql` — pas `000_initial_schema.sql` etc.
    // Le canonical schema (post-migrations snapshot) est typiquement
    // `db/schema.sql`. Les migrations historiques ne comptent pas comme
    // "table vivante" — sinon une table créée en mig 000 puis droppée
    // en mig 039 serait considérée vivante par sa présence dans 000.
    const isCanonicalSchema = (file: string): boolean =>
      path.basename(file) === 'schema.sql' && !file.includes('rollbacks/')

    const livingTablesInSchemaSql = new Set<string>()
    for (const t of tables) {
      if (isCanonicalSchema(t.file)) {
        livingTablesInSchemaSql.add(t.name)
      }
    }
    const droppedNames = new Set(
      droppedTables
        .map((d) => d.table)
        .filter((name) => !livingTablesInSchemaSql.has(name)),
    )
    if (droppedNames.size > 0) {
      // Filter out toutes les entrées (CREATE TABLE + indexes + FKs)
      // qui pointent vers des tables effectivement droppées.
      for (let i = tables.length - 1; i >= 0; i--) {
        if (droppedNames.has(tables[i].name)) tables.splice(i, 1)
      }
      for (let i = indexes.length - 1; i >= 0; i--) {
        if (droppedNames.has(indexes[i].table)) indexes.splice(i, 1)
      }
      for (let i = foreignKeys.length - 1; i >= 0; i--) {
        if (droppedNames.has(foreignKeys[i].fromTable) ||
            droppedNames.has(foreignKeys[i].toTable)) {
          foreignKeys.splice(i, 1)
        }
      }
    }
  }

  // Cross-file merge : ALTER TABLE ADD COLUMN extend les tables existantes.
  // Sans ça, une table créée en migration 023 + colonne ajoutée en migration
  // 073 apparaît comme "manquant la colonne" dans les rules sql-audit-columns.
  //
  // Note : une même table peut apparaître plusieurs fois (000_initial_schema.sql
  // + schema.sql consolidé). On applique le merge à TOUTES les entrées
  // matchant le nom (filter, pas find).
  //
  // ADD COLUMN doit s'appliquer AVANT RENAME — sinon une colonne ajoutée par
  // ALTER puis renommée en migration ultérieure rate son rename (la col
  // n'existe pas encore au moment du rename merge).
  for (const ac of addedColumns) {
    const targets = tables.filter((t) => t.name === ac.table)
    for (const target of targets) {
      // Skip si la colonne existe déjà (idempotence — ALTER TABLE IF NOT EXISTS)
      if (target.columns.some((c) => c.name === ac.column)) continue
      target.columns.push({
        name: ac.column,
        type: ac.type,
        notNull: ac.notNull,
        isUnique: ac.isUnique,
        isPrimaryKey: ac.isPrimaryKey,
        line: ac.line,
      })
    }
  }

  // Cross-file merge : ALTER TABLE RENAME COLUMN renomme les colonnes
  // existantes. Applique à toutes les entrées matchant le nom de table
  // (multiple CREATE TABLE équivalents dans schema.sql + migrations).
  for (const rc of renamedColumns) {
    const targets = tables.filter((t) => t.name === rc.table)
    for (const target of targets) {
      const col = target.columns.find((c) => c.name === rc.fromName)
      if (!col) continue
      col.name = rc.toName
    }
  }

  // Cross-FK + index match
  const fkWithoutIndex = computeFkWithoutIndex(foreignKeys, indexes)
  void tables

  // Dérive primaryKeys depuis tables[].columns + table-level indexes _pkey.
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
 * Dérive les primary keys depuis les structures déjà parsées :
 *   - inline col PK : `id INT PRIMARY KEY`
 *   - table-level PK : `PRIMARY KEY (a, b)` — émis dans indexes avec
 *     name=`<table>_pkey` et `implicit: true`
 * Une PK composite émet une entrée par column.
 */
export function derivePrimaryKeys(tables: SqlTable[], indexes: SqlIndex[]): SqlPrimaryKey[] {
  const pks: SqlPrimaryKey[] = []
  const seen = new Set<string>()
  const add = (table: string, column: string, file: string, line: number): void => {
    const key = table + '\x00' + column
    if (seen.has(key)) return
    seen.add(key)
    pks.push({ table, column, file, line })
  }
  // Inline col PK
  for (const t of tables) {
    for (const c of t.columns) {
      if (c.isPrimaryKey) add(t.name, c.name, t.file, c.line)
    }
  }
  // Table-level PK (depuis indexes implicites _pkey)
  for (const idx of indexes) {
    if (!idx.implicit) continue
    if (!idx.name.endsWith('_pkey')) continue
    for (const col of idx.columns) {
      if (col.includes('(')) continue   // skip expression-based
      add(idx.table, col, idx.file, idx.line)
    }
  }
  return pks
}

/**
 * Parse un fichier SQL et extrait tables, indexes, FKs. Pure (pas
 * d'I/O), utilisable en test. Public pour réutilisation par la version
 * Salsa éventuelle.
 */
export function parseSqlFile(
  content: string,
  file: string,
): { tables: SqlTable[]; indexes: SqlIndex[]; foreignKeys: SqlForeignKey[]; addedColumns: AddedColumn[]; renamedColumns: RenamedColumn[]; droppedTables: DroppedTable[] } {
  const tables: SqlTable[] = []
  const indexes: SqlIndex[] = []
  const foreignKeys: SqlForeignKey[] = []
  const addedColumns: AddedColumn[] = []
  const renamedColumns: RenamedColumn[] = []
  const droppedTables: DroppedTable[] = []

  // ─── CREATE TABLE ────────────────────────────────────────────────
  // Capture: nom + bloc parenthèses (avec parenthèses imbriquées).
  // Approche : chercher `CREATE TABLE ... (` puis matcher la `)` finale
  // en respectant le balance.
  const createTableRe = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(\w+(?:\.\w+)?)\s*\(/gi
  let m: RegExpExecArray | null
  while ((m = createTableRe.exec(content)) !== null) {
    const tableName = stripSchema(m[1])
    const startIdx = m.index + m[0].length
    const tableStartLine = lineNumberAt(content, m.index)

    // Match closing paren via balance
    const blockEnd = matchBalancedParen(content, startIdx)
    if (blockEnd === -1) continue
    const block = content.slice(startIdx, blockEnd)

    const columns = parseTableColumns(block, tableStartLine)
    tables.push({ name: tableName, file, line: tableStartLine, columns })

    // Émet les FKs inline + indexes implicites
    for (const col of columns) {
      if (col.foreignKey) {
        foreignKeys.push({
          fromTable: tableName,
          fromColumn: col.name,
          toTable: col.foreignKey.toTable,
          toColumn: col.foreignKey.toColumn,
          file,
          line: col.line,
        })
      }
      if (col.isPrimaryKey) {
        indexes.push({
          name: `${tableName}_pkey`,
          table: tableName,
          firstColumn: col.name,
          columns: [col.name],
          unique: true,
          implicit: true,
          file,
          line: col.line,
        })
      } else if (col.isUnique) {
        indexes.push({
          name: `${tableName}_${col.name}_key`,
          table: tableName,
          firstColumn: col.name,
          columns: [col.name],
          unique: true,
          implicit: true,
          file,
          line: col.line,
        })
      }
    }

    // Table-level constraints (PRIMARY KEY (a, b), UNIQUE (x, y))
    const tableLevelIndexes = parseTableLevelConstraints(block, tableName, tableStartLine, file)
    indexes.push(...tableLevelIndexes)
  }

  // ─── CREATE INDEX ────────────────────────────────────────────────
  const createIndexRe = /CREATE\s+(UNIQUE\s+)?INDEX(?:\s+CONCURRENTLY)?(?:\s+IF\s+NOT\s+EXISTS)?\s+(\w+)\s+ON\s+(\w+(?:\.\w+)?)\s*\(([^)]+)\)/gi
  while ((m = createIndexRe.exec(content)) !== null) {
    const isUnique = !!m[1]
    const indexName = m[2]
    const tableName = stripSchema(m[3])
    const colsRaw = m[4]
    const cols = parseIndexColumns(colsRaw)
    const firstColumn = cols.length > 0 && !cols[0].includes('(')
      ? cols[0]
      : null  // expression-based, on skip pour le matching FK
    indexes.push({
      name: indexName,
      table: tableName,
      firstColumn,
      columns: cols,
      unique: isUnique,
      implicit: false,
      file,
      line: lineNumberAt(content, m.index),
    })
  }

  // ─── ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY ──────────────
  // Pattern moins fréquent mais à supporter
  const alterFkRe = /ALTER\s+TABLE\s+(\w+(?:\.\w+)?)\s+ADD\s+(?:CONSTRAINT\s+\w+\s+)?FOREIGN\s+KEY\s*\(\s*(\w+)\s*\)\s+REFERENCES\s+(\w+(?:\.\w+)?)\s*\(\s*(\w+)\s*\)/gi
  while ((m = alterFkRe.exec(content)) !== null) {
    foreignKeys.push({
      fromTable: stripSchema(m[1]),
      fromColumn: m[2],
      toTable: stripSchema(m[3]),
      toColumn: m[4],
      file,
      line: lineNumberAt(content, m.index),
    })
  }

  // ─── ALTER TABLE ... ADD COLUMN ──────────────────────────────────
  // Migrations qui étendent une table existante. Sans ce parsing, le
  // détecteur sql-schema ne voit que les CREATE TABLE source — les
  // colonnes ajoutées via ALTER ne sont pas détectées, créant des FP
  // sur les rules sql-audit-columns / sql-fk-needs-index.
  //
  // Pattern : `ALTER TABLE [IF EXISTS] table ADD [COLUMN] [IF NOT EXISTS] col TYPE [...constraints]`
  const alterAddColRe = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+(?:\.\w+)?)\s+ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+([A-Z][A-Z0-9_()]*(?:\([^)]*\))?)\s*([^;,\n]*)/gi
  while ((m = alterAddColRe.exec(content)) !== null) {
    // Skip si match a déjà été parsed comme FK (ALTER TABLE ... ADD CONSTRAINT FK ...)
    if (/FOREIGN\s+KEY/i.test(m[0])) continue
    if (/CONSTRAINT/i.test(m[0])) continue
    // Skip table-level constraints sans CONSTRAINT keyword :
    // `ALTER TABLE x ADD PRIMARY KEY (id)`, `ADD UNIQUE (col)`, `ADD CHECK (...)`.
    // Sans ce skip, le parseur croit voir une col `PRIMARY` de type `KEY`
    // → FP `column-not-snake-case` sur "PRIMARY".
    const colName = m[2].toUpperCase()
    if (colName === 'PRIMARY' || colName === 'UNIQUE' || colName === 'CHECK' || colName === 'EXCLUDE') continue
    addedColumns.push({
      table: stripSchema(m[1]),
      column: m[2],
      type: m[3].trim(),
      notNull: /NOT\s+NULL/i.test(m[4]),
      isUnique: /UNIQUE/i.test(m[4]),
      isPrimaryKey: false,
      file,
      line: lineNumberAt(content, m.index),
    })
  }

  // ─── ALTER TABLE ... RENAME COLUMN ────────────────────────────────
  // Pattern : `ALTER TABLE [IF EXISTS] table RENAME COLUMN old TO new`
  // (variant : `RENAME old TO new` sans COLUMN keyword).
  // Critical pour éviter les FP sur les rules sql-naming/sql-audit-columns
  // après un cleanup rename qui résout déjà la convention.
  const alterRenameColRe = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+(?:\.\w+)?)\s+RENAME\s+(?:COLUMN\s+)?(\w+)\s+TO\s+(\w+)/gi
  while ((m = alterRenameColRe.exec(content)) !== null) {
    renamedColumns.push({
      table: stripSchema(m[1]),
      fromName: m[2],
      toName: m[3],
      file,
      line: lineNumberAt(content, m.index),
    })
  }

  // ─── DROP TABLE ───────────────────────────────────────────────────
  // Pattern : `DROP TABLE [IF EXISTS] table [CASCADE|RESTRICT]`.
  // Une table droppée DOIT être retirée du résultat — sinon les rules
  // sql-naming/sql-audit-columns flaggent des violations sur des tables
  // mortes (cf. mig 039 dropshipping cleanup).
  const dropTableRe = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+(?:\.\w+)?)\s*(?:CASCADE|RESTRICT)?\s*[;,\n]/gi
  while ((m = dropTableRe.exec(content)) !== null) {
    droppedTables.push({
      table: stripSchema(m[1]),
      file,
      line: lineNumberAt(content, m.index),
    })
  }

  return { tables, indexes, foreignKeys, addedColumns, renamedColumns, droppedTables }
}

// Internal helper type for ALTER TABLE ADD COLUMN tracking
interface AddedColumn {
  table: string
  column: string
  type: string
  notNull: boolean
  isUnique: boolean
  isPrimaryKey: boolean
  file: string
  line: number
}

interface RenamedColumn {
  table: string
  fromName: string
  toName: string
  file: string
  line: number
}

// ═════════════════════════════════════════════════════════════════════
// Internal parsers
// ═════════════════════════════════════════════════════════════════════

/**
 * Parse les colonnes d'un bloc CREATE TABLE. Splitte par virgule de
 * top-level (en respectant les parenthèses imbriquées) puis pour chaque
 * déclaration, extrait nom + type + flags + FK inline.
 *
 * Skip les déclarations table-level (PRIMARY KEY, UNIQUE, FOREIGN KEY,
 * CHECK, CONSTRAINT) — ces dernières sont parsées séparément par
 * `parseTableLevelConstraints`.
 */
function parseTableColumns(block: string, tableStartLine: number): SqlColumn[] {
  const decls = splitTopLevel(block, ',')
  const columns: SqlColumn[] = []
  let lineCursor = tableStartLine
  let consumedChars = 0
  for (const decl of decls) {
    const declLines = countNewlines(block.slice(0, consumedChars))
    const declLine = tableStartLine + declLines
    consumedChars += decl.length + 1  // +1 for the comma

    const trimmed = decl.trim()
    if (trimmed.length === 0) continue

    const upper = trimmed.toUpperCase()
    // Skip table-level constraints
    if (
      upper.startsWith('PRIMARY KEY') ||
      upper.startsWith('UNIQUE') ||
      upper.startsWith('FOREIGN KEY') ||
      upper.startsWith('CHECK') ||
      upper.startsWith('CONSTRAINT') ||
      upper.startsWith('EXCLUDE')
    ) continue

    const colMatch = /^(\w+)\s+([A-Z][A-Z0-9_()\[\] ]*?)(?:\s|$)/i.exec(trimmed)
    if (!colMatch) continue
    const name = colMatch[1]
    if (name.toUpperCase() === 'PRIMARY' || name.toUpperCase() === 'FOREIGN') continue

    const type = colMatch[2].trim().replace(/\s+/g, ' ')
    const declUpper = trimmed.toUpperCase()
    const notNull = /\bNOT\s+NULL\b/.test(declUpper)
    const isUnique = /\bUNIQUE\b/.test(declUpper) && !/\bUNIQUE\s*\(/.test(declUpper)
    const isPrimaryKey = /\bPRIMARY\s+KEY\b/.test(declUpper)

    // Inline FK : `REFERENCES table(col)`
    const fkMatch = /REFERENCES\s+(\w+(?:\.\w+)?)\s*\(\s*(\w+)\s*\)/i.exec(trimmed)
    const foreignKey = fkMatch
      ? { toTable: stripSchema(fkMatch[1]), toColumn: fkMatch[2] }
      : undefined

    columns.push({ name, type, notNull, isUnique, isPrimaryKey, foreignKey, line: declLine })
    lineCursor = declLine
  }
  return columns
}

/**
 * Parse les contraintes table-level (PRIMARY KEY (a, b), UNIQUE (x, y))
 * → émet des indexes implicites.
 */
function parseTableLevelConstraints(
  block: string,
  tableName: string,
  tableStartLine: number,
  file: string,
): SqlIndex[] {
  const indexes: SqlIndex[] = []
  const decls = splitTopLevel(block, ',')
  let consumedChars = 0
  for (const decl of decls) {
    const declLine = tableStartLine + countNewlines(block.slice(0, consumedChars))
    consumedChars += decl.length + 1

    const trimmed = decl.trim()
    const upper = trimmed.toUpperCase()
    if (upper.startsWith('PRIMARY KEY')) {
      const cols = extractColsBetweenParens(trimmed)
      if (cols.length > 0) {
        indexes.push({
          name: `${tableName}_pkey`,
          table: tableName,
          firstColumn: cols[0],
          columns: cols,
          unique: true,
          implicit: true,
          file,
          line: declLine,
        })
      }
    } else if (upper.startsWith('UNIQUE')) {
      const cols = extractColsBetweenParens(trimmed)
      if (cols.length > 0) {
        indexes.push({
          name: `${tableName}_${cols.join('_')}_key`,
          table: tableName,
          firstColumn: cols[0],
          columns: cols,
          unique: true,
          implicit: true,
          file,
          line: declLine,
        })
      }
    }
  }
  return indexes
}

function parseIndexColumns(raw: string): string[] {
  return raw
    .split(',')
    .map((c) => c.trim().replace(/\s+(ASC|DESC)\s*$/i, '').trim())
    .filter((c) => c.length > 0)
}

function extractColsBetweenParens(decl: string): string[] {
  const match = /\(\s*([^)]+?)\s*\)/.exec(decl)
  if (!match) return []
  return match[1].split(',').map((c) => c.trim().replace(/\s+(ASC|DESC)\s*$/i, '').trim())
}

/**
 * Splitte une string par séparateur top-level (en respectant les
 * parenthèses imbriquées).
 */
function splitTopLevel(s: string, sep: string): string[] {
  const stripped = stripSqlComments(s)
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const c of stripped) {
    if (c === '(') depth++
    else if (c === ')') depth--
    if (c === sep && depth === 0) {
      out.push(cur)
      cur = ''
    } else {
      cur += c
    }
  }
  if (cur.length > 0) out.push(cur)
  return out
}

/**
 * Strip les commentaires SQL ligne (`-- ... \n`) en préservant le `\n`
 * pour ne pas casser les calculs de line:line numbers basés sur
 * `countNewlines(slice)`. Les caractères du commentaire sont remplacés
 * par des espaces pour conserver la longueur.
 *
 * Pourquoi : sans strip, un commentaire comme `-- API v3 (videos.list)`
 * contient une parenthèse qui désynchronise le tracker de profondeur
 * dans `splitTopLevel`. Toutes les decls suivantes sont alors collées
 * en une seule grosse decl. Bug détecté sur les migrations Sentinel
 * avec PK composite après des colonnes commentées.
 */
function stripSqlComments(s: string): string {
  let out = ''
  let i = 0
  while (i < s.length) {
    if (s[i] === '-' && s[i + 1] === '-') {
      // Skip jusqu'à \n (exclusif), remplacer par des espaces.
      while (i < s.length && s[i] !== '\n') {
        out += ' '
        i++
      }
    } else {
      out += s[i]
      i++
    }
  }
  return out
}

/**
 * Trouve la `)` qui ferme la `(` à `startIdx - 1`. Retourne l'index de
 * la `)` ou -1 si pas trouvé.
 */
function matchBalancedParen(content: string, startIdx: number): number {
  let depth = 1
  for (let i = startIdx; i < content.length; i++) {
    if (content[i] === '(') depth++
    else if (content[i] === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function lineNumberAt(content: string, idx: number): number {
  return countNewlines(content.slice(0, idx)) + 1
}

function countNewlines(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++
  return n
}

function stripSchema(qualifiedName: string): string {
  // `public.users` → `users`. Garde tel quel si pas de point.
  const idx = qualifiedName.indexOf('.')
  return idx === -1 ? qualifiedName : qualifiedName.slice(idx + 1)
}
