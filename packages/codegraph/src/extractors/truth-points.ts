/**
 * Truth Points Extractor — structural map phase 1.4
 *
 * Pour chaque concept de donnée partagée, nomme sa source canonique (table
 * PG), ses miroirs (Redis, caches in-memory), ses écrivains, ses lecteurs,
 * ses points d'exposition (fonctions get/find/read/list, routes HTTP GET,
 * tools MCP sentinel_get_*).
 *
 * L'extracteur est déterministe, zéro LLM, zéro I/O externe. Couverture
 * incomplète assumée : les patterns d'accès non-SQL (query builder
 * complexes, ORM) peuvent être ratés. Dans le doute, on omet — jamais
 * d'affirmation floue.
 *
 * Heuristiques :
 *   - Concept = nom de table détecté par les patterns SQL.
 *   - Mirror redis = clé d'un `redis.set/setex/hset/...` dont le premier
 *     segment (`foo:` ou `foo-`) matche partiellement le nom de table.
 *   - Mirror memory = variable `*Cache|*Store|*Registry` initialisée à
 *     `new Map(...)` / `new LRUCache(...)` / `new WeakMap(...)`, dont le
 *     préfixe de nom matche le concept.
 *   - Exposed function = export `get*|find*|read*|list*` dont le reste du
 *     nom (après le préfixe, en CamelCase → snake_case) matche le concept.
 *
 * Matching concept ↔ clé/nom :
 *   - Aliases explicites via `detectorOptions.truthPoints.conceptAliases`
 *     (`{trust_score: ["trust:", "trustScore"]}`) — priorité absolue.
 *   - Fallback déterministe : intersection de sous-chaîne de longueur ≥ 3
 *     entre nom de table (lower) et segment de clé/nom (lower), avec
 *     tolérance singulier/pluriel.
 */

import { Project, SyntaxKind, type SourceFile, type Node, type VariableDeclaration } from 'ts-morph'
import * as path from 'node:path'
import type {
  TruthPoint,
  TruthMirror,
  TruthRef,
  TruthExposure,
  GraphEdge,
} from '../core/types.js'

// ─── Options ────────────────────────────────────────────────────────────────

export interface TruthPointsOptions {
  /**
   * Aliases explicites concept → liste de patterns à matcher dans les clés
   * Redis / noms de variables / noms de fonctions. Priorité absolue sur
   * l'heuristique de fallback.
   * Ex : { trust_score: ['trust:', 'trustScore'], approvals: ['approval:'] }
   */
  conceptAliases?: Record<string, string[]>
  /**
   * Noms de variables JS identifiées comme des clients Redis (détection par
   * forme `<redisVarName>.set(key, ...)` ). Default : redis, client, pipeline, pipe.
   */
  redisVarNames?: string[]
  /**
   * Suffixes de nom de variable reconnus comme caches in-memory.
   * Default : Cache, Store, Registry.
   */
  memoryCacheSuffixes?: string[]
  /**
   * Constructeurs reconnus comme caches in-memory (callee du `new X()`).
   * Default : Map, LRUCache, WeakMap, LRU.
   */
  memoryCacheCtors?: string[]
  /**
   * Préfixes de nom de fonction exportée reconnus comme exposition de lecture.
   * Default : get, find, read, list.
   */
  exposedPrefixes?: string[]
}

const DEFAULT_REDIS_VARS = ['redis', 'client', 'pipeline', 'pipe']
const DEFAULT_MEM_SUFFIXES = ['Cache', 'Store', 'Registry']
const DEFAULT_MEM_CTORS = ['Map', 'LRUCache', 'WeakMap', 'LRU']
const DEFAULT_EXPOSED_PREFIXES = ['get', 'find', 'read', 'list']

// Méthodes Redis d'écriture (portent une clé en premier argument).
const REDIS_WRITE_METHODS = new Set([
  'set', 'setex', 'hset', 'hmset', 'sadd', 'zadd', 'lpush', 'rpush',
  'incr', 'decr', 'incrby', 'decrby', 'expire', 'pexpire', 'del',
])
// Méthodes de lecture — on les capture aussi pour signaler les readers de
// mirrors, utile pour la vue complète mais v1 on se concentre sur les writes.
// const REDIS_READ_METHODS = new Set(['get', 'hget', 'hmget', 'smembers', ...])

// Exclure les matches SQL qui ne sont pas des tables (cf. db-tables detector).
const SQL_EXCLUDE = new Set([
  'information_schema', 'pg_catalog', 'pg_tables', 'set', 'select',
  'where', 'and', 'or', 'not', 'true', 'false', 'null', 'values',
  'returning', 'case', 'when', 'then', 'else', 'end',
])

// ─── Raw signals (collectés en pass 1) ──────────────────────────────────────

export interface SqlSignal {
  file: string
  table: string
  operation: 'read' | 'write'
  line: number
  symbol: string
}

export interface RedisSignal {
  file: string
  method: string
  key: string
  ttl?: string
  line: number
  symbol: string
}

export interface MemorySignal {
  file: string
  varName: string
  ctor: string
  line: number
}

export interface ExportedFnSignal {
  file: string
  name: string
  prefix: string  // le préfixe matché ('get', 'find', ...)
  line: number
}

/**
 * Bundle de tous les signaux qu'on peut tirer d'UN SourceFile sans
 * cross-file dependency. Réutilisé par la version Salsa.
 */
export interface TruthPointsFileBundle {
  sql: SqlSignal[]
  redis: RedisSignal[]
  memory: MemorySignal[]
  exportedFns: ExportedFnSignal[]
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function analyzeTruthPoints(
  rootDir: string,
  files: string[],
  project: Project,
  allEdges: GraphEdge[],
  options: TruthPointsOptions = {},
): Promise<TruthPoint[]> {
  const redisVars = new Set(options.redisVarNames ?? DEFAULT_REDIS_VARS)
  const memSuffixes = options.memoryCacheSuffixes ?? DEFAULT_MEM_SUFFIXES
  const memCtors = new Set(options.memoryCacheCtors ?? DEFAULT_MEM_CTORS)
  const exposedPrefixes = options.exposedPrefixes ?? DEFAULT_EXPOSED_PREFIXES
  const aliases = options.conceptAliases ?? {}
  const fileSet = new Set(files)

  // ─── Pass 1 : collect signals (per-file, via helper réutilisable) ──

  const sqlSignals: SqlSignal[] = []
  const redisSignals: RedisSignal[] = []
  const memorySignals: MemorySignal[] = []
  const exportedFns: ExportedFnSignal[] = []

  for (const sf of project.getSourceFiles()) {
    const relPath = relativize(sf.getFilePath(), rootDir)
    if (!relPath || !fileSet.has(relPath)) continue
    const bundle = extractTruthPointsFileBundle(
      sf,
      relPath,
      redisVars,
      memSuffixes,
      memCtors,
      exposedPrefixes,
    )
    sqlSignals.push(...bundle.sql)
    redisSignals.push(...bundle.redis)
    memorySignals.push(...bundle.memory)
    exportedFns.push(...bundle.exportedFns)
  }

  return buildTruthPointsFromSignals(
    files, sqlSignals, redisSignals, memorySignals, exportedFns,
    allEdges, fileSet, aliases, memSuffixes,
  )
}

/**
 * Helper réutilisable : tire tous les signaux qu'on peut extraire d'UN
 * SourceFile (sql, redis, memory, exportedFns) sans cross-file
 * dependency. Réutilisé par la version Salsa pour cacher tout ça
 * par-fichier.
 */
export function extractTruthPointsFileBundle(
  sf: SourceFile,
  relPath: string,
  redisVars: ReadonlySet<string>,
  memSuffixes: string[],
  memCtors: ReadonlySet<string>,
  exposedPrefixes: string[],
): TruthPointsFileBundle {
  const sql: SqlSignal[] = []
  const redis: RedisSignal[] = []
  const memory: MemorySignal[] = []
  const exportedFns: ExportedFnSignal[] = []

  const content = sf.getFullText()

  collectSqlSignals(content, relPath, sf, sql)

  const orm = detectOrmUsage(content)
  if (orm.drizzle || orm.prisma) {
    collectOrmSignals(sf, relPath, orm, sql)
  }

  collectAstSignals(
    sf, relPath,
    redisVars as Set<string>,
    memSuffixes,
    memCtors as Set<string>,
    exposedPrefixes,
    redis, memory, exportedFns,
  )

  return { sql, redis, memory, exportedFns }
}

/**
 * Pure-logic builder : à partir des signaux agrégés + edges du graph,
 * construit les `TruthPoint[]`. Réutilisé côté Salsa après agrégation
 * des bundles per-file.
 */
export function buildTruthPointsFromSignals(
  files: string[],
  sqlSignals: SqlSignal[],
  redisSignals: RedisSignal[],
  memorySignals: MemorySignal[],
  exportedFns: ExportedFnSignal[],
  allEdges: GraphEdge[],
  fileSet: ReadonlySet<string>,
  aliases: Record<string, string[]>,
  memSuffixes: string[],
): TruthPoint[] {
  const mcpToolFiles = new Set(files.filter((f) => /\/mcp\/tools\//.test(f)))

  // Routes HTTP GET : on les tire des edges `route` existants (label = path).
  const httpGetRoutes: Array<{ file: string; path: string }> = []
  for (const e of allEdges) {
    if (e.type !== 'route') continue
    if (!fileSet.has(e.from) && !fileSet.has(e.to)) continue
    const label = e.label ?? ''
    // Les labels de route sont parfois préfixés "GET " / "POST " ; on retient
    // seulement ce qui ressemble à un path. Heuristique prudente — si on
    // doute, on omet.
    if (label.startsWith('/api/') || label.startsWith('/health')) {
      const fromInFiles = fileSet.has(e.from) ? e.from : e.to
      httpGetRoutes.push({ file: fromInFiles, path: label })
    }
  }

  const tableNames = new Set<string>()
  for (const s of sqlSignals) tableNames.add(s.table)

  const truthPoints: TruthPoint[] = []

  for (const table of [...tableNames].sort()) {
    const concept = table  // v1 : concept = nom de table, sans singularisation.
    const extraPatterns = aliases[concept] ?? aliases[singularize(concept)] ?? []

    const writers: TruthRef[] = sqlSignals
      .filter((s) => s.table === table && s.operation === 'write')
      .map((s) => ({ file: s.file, symbol: s.symbol, line: s.line }))

    const readers: TruthRef[] = sqlSignals
      .filter((s) => s.table === table && s.operation === 'read')
      .map((s) => ({ file: s.file, symbol: s.symbol, line: s.line }))

    // Miroirs : redis + memory matchant le concept.
    const mirrors: TruthMirror[] = []

    for (const r of redisSignals) {
      if (!conceptMatchesKey(table, r.key, extraPatterns)) continue
      mirrors.push({
        kind: 'redis',
        key: r.key,
        ...(r.ttl ? { ttl: r.ttl } : {}),
        file: r.file,
        line: r.line,
      })
    }

    for (const m of memorySignals) {
      // Pour les caches, stripper le suffixe reconnu AVANT matching : le nom
      // `trustCache` doit matcher la table `trust_scores` via la base `trust`.
      const base = stripCacheSuffix(m.varName, memSuffixes)
      const matches =
        conceptMatchesKey(table, m.varName, extraPatterns) ||
        (base !== m.varName && conceptMatchesKey(table, base, extraPatterns))
      if (!matches) continue
      mirrors.push({
        kind: 'memory',
        key: m.varName,
        file: m.file,
        line: m.line,
      })
    }

    // Exposed : exports get/find/read/list dont le nom (sans préfixe) matche,
    // + routes HTTP GET dans un fichier writer/reader, + MCP tools sentinel_get_*
    // dans un fichier writer/reader.
    const exposed: TruthExposure[] = []

    const writerReaderFiles = new Set<string>([
      ...writers.map((w) => w.file),
      ...readers.map((r) => r.file),
    ])

    for (const fn of exportedFns) {
      const rest = fn.name.slice(fn.prefix.length)
      if (!conceptMatchesName(table, rest, extraPatterns)) continue
      exposed.push({ kind: 'function', id: fn.name, file: fn.file, line: fn.line })
    }

    for (const route of httpGetRoutes) {
      if (!writerReaderFiles.has(route.file)) continue
      exposed.push({ kind: 'route', id: route.path, file: route.file })
    }

    for (const toolFile of mcpToolFiles) {
      if (!writerReaderFiles.has(toolFile)) continue
      // Nom dérivé du filename : tools/foo.ts → sentinel_get_foo candidate —
      // imparfait, mais le fichier MCP existe et touche le concept, c'est
      // l'info qui compte pour la carte.
      const base = path.basename(toolFile, '.ts')
      exposed.push({ kind: 'mcp-tool', id: `mcp:${base}`, file: toolFile })
    }

    // Dédup + tri stable.
    const dedupMirrors = dedup(mirrors, (m) => `${m.kind}|${m.key}|${m.file}|${m.line}`)
    const dedupExposed = dedup(exposed, (e) => `${e.kind}|${e.id}|${e.file ?? ''}`)

    dedupMirrors.sort(cmpMirror)
    dedupExposed.sort(cmpExposure)
    writers.sort(cmpRef)
    readers.sort(cmpRef)

    // Pas de miroirs + un seul writer/reader => truth point peu informatif ;
    // on le garde quand même pour la complétude (la carte doit tout lister).

    truthPoints.push({
      concept,
      canonical: { kind: 'table', name: table },
      mirrors: dedupMirrors,
      writers,
      readers,
      exposed: dedupExposed,
    })
  }

  // Tri déterministe : canonical avec mirrors d'abord (plus riche en signal),
  // puis par nom de concept.
  truthPoints.sort((a, b) => {
    const aHas = a.mirrors.length > 0 ? 1 : 0
    const bHas = b.mirrors.length > 0 ? 1 : 0
    if (aHas !== bHas) return bHas - aHas
    return a.concept < b.concept ? -1 : a.concept > b.concept ? 1 : 0
  })

  return truthPoints
}

// ─── SQL signal collection ──────────────────────────────────────────────────

function collectSqlSignals(
  content: string,
  file: string,
  sf: SourceFile,
  out: SqlSignal[],
): void {
  // Court-circuit : si aucun mot SQL n'apparaît dans le fichier, on saute
  // tout le walk AST. Gain perf majeur (la plupart des fichiers TS n'ont
  // pas de SQL).
  if (
    !content.includes('SELECT') &&
    !content.includes('INSERT') &&
    !content.includes('UPDATE') &&
    !content.includes('DELETE') &&
    !content.includes('FROM')
  ) {
    return
  }

  // Patterns SQL-write/read. `FROM` est sensible à un overlap avec
  // `DELETE FROM` — filtré ci-dessous.
  const patterns: Array<{ regex: RegExp; operation: 'read' | 'write' }> = [
    { regex: /\bFROM\s+(\w+)/gi, operation: 'read' },
    { regex: /\bJOIN\s+(\w+)/gi, operation: 'read' },
    { regex: /\bINSERT\s+INTO\s+(\w+)/gi, operation: 'write' },
    { regex: /\bUPDATE\s+(\w+)\s+SET/gi, operation: 'write' },
    { regex: /\bDELETE\s+FROM\s+(\w+)/gi, operation: 'write' },
  ]

  const lineToSymbol = buildLineToSymbol(sf)

  // Scan AST : on ne regarde que les string literals et template literals.
  // CRUCIAL vs v1 : éviter les faux positifs sur les commentaires et noms
  // de variables (ex: `from connected clients` dans un commentaire JSDoc,
  // ou `const fromDb = ...`). Un SQL existe dans une string, jamais ailleurs.
  sf.forEachDescendant((node) => {
    const k = node.getKind()
    let text: string | null = null
    let startOffset = 0

    if (k === SyntaxKind.StringLiteral || k === SyntaxKind.NoSubstitutionTemplateLiteral) {
      const n = node as any
      text = n.getLiteralText?.() ?? null
      // getStart() retourne la position du token (y.c. quotes). +1 pour
      // compenser le premier ' / " / `.
      startOffset = (n.getStart?.() ?? 0) + 1
    } else if (k === SyntaxKind.TemplateExpression || k === SyntaxKind.TemplateHead || k === SyntaxKind.TemplateMiddle || k === SyntaxKind.TemplateTail) {
      // Pour les template strings avec ${}, on scanne chaque fragment.
      // TemplateExpression englobe head+middle+tail ; on traite au niveau
      // des sous-fragments pour garder les offsets corrects.
      if (k !== SyntaxKind.TemplateExpression) {
        const n = node as any
        text = n.getLiteralText?.() ?? null
        startOffset = (n.getStart?.() ?? 0) + 1  // +1 pour le backtick / }
      }
    }

    if (!text) return

    // Court-circuit par fragment.
    if (
      !text.includes('SELECT') &&
      !text.includes('INSERT') &&
      !text.includes('UPDATE') &&
      !text.includes('DELETE') &&
      !text.includes('FROM')
    ) {
      return
    }

    for (const { regex, operation } of patterns) {
      regex.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = regex.exec(text)) !== null) {
        const table = match[1].toLowerCase()
        if (SQL_EXCLUDE.has(table)) continue
        if (table.startsWith('$')) continue
        if (table.length < 2) continue
        if (/^\d/.test(table)) continue

        // Overlap DELETE FROM : le pattern FROM tire aussi sur `DELETE FROM`.
        if (operation === 'read' && regex.source.startsWith('\\bFROM')) {
          const before = text.substring(Math.max(0, match.index - 15), match.index)
          if (/\bDELETE\s+$/i.test(before)) continue
        }

        // Position absolue dans le fichier → ligne (même calcul que v1).
        const absIdx = startOffset + match.index
        const line = content.substring(0, absIdx).split('\n').length
        const symbol = lineToSymbol.get(line) ?? ''
        out.push({ file, table, operation, line, symbol })
      }
    }
  })
}

/**
 * Pour chaque ligne du fichier, le symbole de la fonction englobante.
 * Balaye une seule fois toutes les fonctions/méthodes/arrows assignées à
 * des consts et produit un range → name, puis aplatit ligne par ligne.
 */
function buildLineToSymbol(sf: SourceFile): Map<number, string> {
  const ranges: Array<{ start: number; end: number; name: string }> = []

  for (const fd of sf.getFunctions()) {
    const name = fd.getName()
    if (!name) continue
    ranges.push({ start: fd.getStartLineNumber(), end: fd.getEndLineNumber(), name })
  }

  for (const cd of sf.getClasses()) {
    const className = cd.getName() ?? '<anonymous>'
    for (const m of cd.getMethods()) {
      ranges.push({
        start: m.getStartLineNumber(),
        end: m.getEndLineNumber(),
        name: `${className}.${m.getName()}`,
      })
    }
    const ctor = cd.getConstructors()[0]
    if (ctor) {
      ranges.push({
        start: ctor.getStartLineNumber(),
        end: ctor.getEndLineNumber(),
        name: `${className}.constructor`,
      })
    }
  }

  for (const vs of sf.getVariableStatements()) {
    for (const vd of vs.getDeclarations()) {
      const init = vd.getInitializer()
      if (!init) continue
      const k = init.getKind()
      if (k !== SyntaxKind.ArrowFunction && k !== SyntaxKind.FunctionExpression) continue
      ranges.push({
        start: vd.getStartLineNumber(),
        end: vd.getEndLineNumber(),
        name: vd.getName(),
      })
    }
  }

  // Priorité : range plus étroit gagne (fonction intérieure). On trie par
  // largeur croissante puis on remplit la map dans cet ordre — le dernier
  // `set` ne l'emporte pas, on protège avec un `has`.
  ranges.sort((a, b) => (a.end - a.start) - (b.end - b.start))

  const out = new Map<number, string>()
  for (const r of ranges) {
    for (let l = r.start; l <= r.end; l++) {
      if (!out.has(l)) out.set(l, r.name)
    }
  }
  return out
}

// ─── AST signal collection ──────────────────────────────────────────────────

function collectAstSignals(
  sf: SourceFile,
  file: string,
  redisVars: Set<string>,
  memSuffixes: string[],
  memCtors: Set<string>,
  exposedPrefixes: string[],
  redisSignals: RedisSignal[],
  memorySignals: MemorySignal[],
  exportedFns: ExportedFnSignal[],
): void {
  const lineToSymbol = buildLineToSymbol(sf)

  // Redis : `redis.set(key, val, 'EX', ttl)` / `redis.setex(key, ttl, val)` etc.
  sf.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.CallExpression) return
    const call = node as any
    const expr = call.getExpression?.()
    if (!expr || expr.getKind() !== SyntaxKind.PropertyAccessExpression) return
    const left = expr.getExpression?.()
    const method = expr.getName?.()
    if (!left || left.getKind() !== SyntaxKind.Identifier) return
    if (!redisVars.has(left.getText())) return
    if (!method || !REDIS_WRITE_METHODS.has(method)) return

    const args = call.getArguments?.() ?? []
    if (args.length === 0) return

    const key = extractLiteralString(args[0])
    if (!key) return  // clé dynamique sans préfixe — on omet

    const line = call.getStartLineNumber?.() ?? 0
    const ttl = extractTtl(method, args)
    redisSignals.push({
      file,
      method,
      key,
      ...(ttl ? { ttl } : {}),
      line,
      symbol: lineToSymbol.get(line) ?? '',
    })
  })

  // Memory caches : `const nameCache = new Map(...)` / `new LRUCache(...)`.
  for (const vs of sf.getVariableStatements()) {
    for (const vd of vs.getDeclarations()) {
      const match = matchMemoryCache(vd, memSuffixes, memCtors)
      if (!match) continue
      memorySignals.push({
        file,
        varName: vd.getName(),
        ctor: match,
        line: vd.getStartLineNumber(),
      })
    }
  }

  // Exports get/find/read/list.
  for (const fd of sf.getFunctions()) {
    if (!fd.isExported()) continue
    const name = fd.getName()
    if (!name) continue
    const prefix = exposedPrefixes.find((p) => startsWithPrefix(name, p))
    if (!prefix) continue
    exportedFns.push({ file, name, prefix, line: fd.getStartLineNumber() })
  }
  for (const vs of sf.getVariableStatements()) {
    if (!vs.isExported()) continue
    for (const vd of vs.getDeclarations()) {
      const init = vd.getInitializer()
      if (!init) continue
      const k = init.getKind()
      if (k !== SyntaxKind.ArrowFunction && k !== SyntaxKind.FunctionExpression) continue
      const name = vd.getName()
      const prefix = exposedPrefixes.find((p) => startsWithPrefix(name, p))
      if (!prefix) continue
      exportedFns.push({ file, name, prefix, line: vd.getStartLineNumber() })
    }
  }
}

function matchMemoryCache(
  vd: VariableDeclaration,
  memSuffixes: string[],
  memCtors: Set<string>,
): string | null {
  const name = vd.getName()
  const matchesSuffix = memSuffixes.some((s) =>
    name.endsWith(s) && name.length > s.length,
  )
  if (!matchesSuffix) return null

  const init = vd.getInitializer()
  if (!init || init.getKind() !== SyntaxKind.NewExpression) return null
  const ctorName = (init as any).getExpression?.()?.getText?.()
  if (!ctorName || typeof ctorName !== 'string') return null
  // Gérer `new foo.Map()` en prenant la partie droite.
  const ctorBase = ctorName.split('.').pop()!
  if (!memCtors.has(ctorBase)) return null
  return ctorBase
}

// ─── ORM detection (phase 3.6, A.2) ─────────────────────────────────────────

interface OrmUsage {
  drizzle: boolean
  prisma: boolean
}

/**
 * Détecte si le fichier importe un ORM connu. Gate strict pour n'activer
 * le scan ORM que là où il a du sens — évite des dizaines de faux
 * positifs (arrays/sets/crypto qui utilisent aussi `.insert/.update/.delete`).
 *
 * Sentinel actuel n'utilise aucun ORM → ne sera jamais déclenché, zéro
 * impact. Portabilité à un projet Drizzle / Prisma : activation auto.
 */
function detectOrmUsage(content: string): OrmUsage {
  return {
    // Drizzle : `import { ... } from 'drizzle-orm'` ou `'drizzle-orm/xxx'`.
    drizzle: /from\s+['"]drizzle-orm(?:\/|['"])/m.test(content),
    // Prisma : `import { PrismaClient } from '@prisma/client'`.
    prisma: /from\s+['"]@prisma\/client['"]/m.test(content),
  }
}

const DRIZZLE_READ_METHODS = new Set([
  'from', 'innerJoin', 'leftJoin', 'rightJoin', 'fullJoin',
])
const DRIZZLE_WRITE_METHODS = new Set(['insert', 'update', 'delete'])

// Prisma : `<client>.<model>.<method>(...)` — 3-level property access.
// On restreint le client name pour limiter les faux positifs.
const PRISMA_CLIENT_NAMES = new Set(['prisma', 'db', 'client', 'pc'])
const PRISMA_READ_METHODS = new Set([
  'findMany', 'findFirst', 'findUnique', 'findUniqueOrThrow',
  'findFirstOrThrow', 'count', 'aggregate', 'groupBy',
])
const PRISMA_WRITE_METHODS = new Set([
  'create', 'createMany', 'update', 'updateMany',
  'upsert', 'delete', 'deleteMany',
])

/**
 * Scan ORM patterns et émet des `SqlSignal`. Appelé uniquement pour les
 * fichiers qui importent un ORM (gate via `detectOrmUsage`).
 *
 * Patterns détectés :
 *   - Drizzle : `<any>.insert(<Ident>)` / `.update(<Ident>)` / `.delete(<Ident>)` → write
 *               `<any>.from(<Ident>)` → read
 *     L'identifier passé est pris comme nom de table (les schemas Drizzle
 *     déclarent typiquement `export const users = pgTable('users', ...)`,
 *     le nom TS du symbole est utilisé tel quel).
 *   - Prisma  : `(prisma|db|client|pc).<model>.<crudMethod>(...)` → read/write
 *               selon le method name.
 */
function collectOrmSignals(
  sf: SourceFile,
  file: string,
  orm: OrmUsage,
  out: SqlSignal[],
): void {
  const lineToSymbol = buildLineToSymbol(sf)

  sf.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.CallExpression) return
    const call = node as any
    const expr = call.getExpression?.()
    if (!expr || expr.getKind() !== SyntaxKind.PropertyAccessExpression) return

    const method = expr.getName?.()
    if (!method) return

    // ── Drizzle-style : `<any>.<method>(<Ident>)` ──
    if (orm.drizzle) {
      let drizzleOp: 'read' | 'write' | null = null
      if (DRIZZLE_WRITE_METHODS.has(method)) drizzleOp = 'write'
      else if (DRIZZLE_READ_METHODS.has(method)) drizzleOp = 'read'

      if (drizzleOp) {
        const args = call.getArguments?.() ?? []
        if (args.length > 0 && args[0].getKind() === SyntaxKind.Identifier) {
          const tableIdent = args[0].getText()
          // Guard : ignorer les identifiers trop génériques qui ne seraient
          // pas des tables (ex: `this`, `super`, vars 1 char).
          if (tableIdent.length >= 2 && !['this', 'super'].includes(tableIdent)) {
            const line = call.getStartLineNumber?.() ?? 0
            out.push({
              file,
              table: tableIdent.toLowerCase(),
              operation: drizzleOp,
              line,
              symbol: lineToSymbol.get(line) ?? '',
            })
            return
          }
        }
      }
    }

    // ── Prisma-style : `(prisma|db|client).<model>.<method>(...)` ──
    if (orm.prisma) {
      let prismaOp: 'read' | 'write' | null = null
      if (PRISMA_READ_METHODS.has(method)) prismaOp = 'read'
      else if (PRISMA_WRITE_METHODS.has(method)) prismaOp = 'write'

      if (prismaOp) {
        const tableAccess = expr.getExpression?.()
        if (!tableAccess || tableAccess.getKind?.() !== SyntaxKind.PropertyAccessExpression) return
        const tableName = tableAccess.getName?.()
        const clientNode = tableAccess.getExpression?.()
        if (!tableName || !clientNode) return
        if (clientNode.getKind?.() !== SyntaxKind.Identifier) return
        const clientName = clientNode.getText()
        if (!PRISMA_CLIENT_NAMES.has(clientName)) return

        const line = call.getStartLineNumber?.() ?? 0
        out.push({
          file,
          table: tableName.toLowerCase(),
          operation: prismaOp,
          line,
          symbol: lineToSymbol.get(line) ?? '',
        })
      }
    }
  })
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractLiteralString(node: any): string | null {
  if (!node) return null
  const k = node.getKind?.()
  if (k === SyntaxKind.StringLiteral) return node.getLiteralText?.() ?? null
  if (k === SyntaxKind.NoSubstitutionTemplateLiteral) return node.getLiteralText?.() ?? null
  if (k === SyntaxKind.TemplateExpression) {
    // Conserver la forme brute avec ${...} pour que la clé reste signifiante.
    return node.getText?.().slice(1, -1) ?? null  // strip backticks
  }
  return null
}

function extractTtl(method: string, args: any[]): string | undefined {
  // setex(key, ttl, value)
  if (method === 'setex' && args.length >= 2) {
    const v = extractLiteralNumber(args[1])
    return v ?? undefined
  }
  // set(key, value, 'EX', ttl)
  if (method === 'set' && args.length >= 4) {
    const flag = extractLiteralString(args[2])
    if (flag && /^(EX|PX)$/i.test(flag)) {
      const v = extractLiteralNumber(args[3])
      return v ?? undefined
    }
  }
  // expire(key, ttl)
  if ((method === 'expire' || method === 'pexpire') && args.length >= 2) {
    const v = extractLiteralNumber(args[1])
    return v ?? undefined
  }
  return undefined
}

function extractLiteralNumber(node: any): string | null {
  if (!node) return null
  const k = node.getKind?.()
  if (k === SyntaxKind.NumericLiteral) return node.getText?.() ?? null
  return null
}

// ─── Matching concept ↔ key / name ──────────────────────────────────────────

function conceptMatchesKey(
  table: string,
  key: string,
  extraPatterns: string[],
): boolean {
  const k = key.toLowerCase()
  // Alias explicite : priorité.
  for (const p of extraPatterns) {
    if (k.includes(p.toLowerCase())) return true
  }
  // Segment de clé (premier token avant : ou . ou -) contre nom de table.
  const firstSeg = k.split(/[:.\-]/)[0] ?? k
  if (firstSeg.length < 3) return false
  const t = table.toLowerCase()
  if (overlap(t, firstSeg)) return true
  if (overlap(singularize(t), firstSeg)) return true
  if (overlap(t, singularize(firstSeg))) return true
  return false
}

function conceptMatchesName(
  table: string,
  namePart: string,
  extraPatterns: string[],
): boolean {
  const n = camelToSnake(namePart).toLowerCase()
  for (const p of extraPatterns) {
    if (n.includes(p.toLowerCase())) return true
    if (namePart.toLowerCase().includes(p.toLowerCase())) return true
  }
  const t = table.toLowerCase()
  if (overlap(t, n)) return true
  if (overlap(singularize(t), n)) return true
  if (overlap(t, singularize(n))) return true
  return false
}

/**
 * Deux chaînes "chevauchent" si l'une contient l'autre en tant que sous-chaîne,
 * avec un seuil minimal pour éviter les matches dégénérés sur `at` / `of` / `id`.
 */
function overlap(a: string, b: string): boolean {
  if (a.length < 3 || b.length < 3) return false
  if (a.includes(b) || b.includes(a)) return true
  return false
}

function stripCacheSuffix(name: string, suffixes: string[]): string {
  for (const s of suffixes) {
    if (name.endsWith(s) && name.length > s.length) {
      return name.slice(0, -s.length)
    }
  }
  return name
}

function singularize(s: string): string {
  if (s.endsWith('ies') && s.length > 3) return s.slice(0, -3) + 'y'
  if (s.endsWith('es') && s.length > 3) return s.slice(0, -2)
  if (s.endsWith('s') && s.length > 2) return s.slice(0, -1)
  return s
}

function camelToSnake(s: string): string {
  return s.replace(/([A-Z])/g, '_$1').replace(/^_/, '').toLowerCase()
}

function startsWithPrefix(name: string, prefix: string): boolean {
  if (!name.startsWith(prefix)) return false
  if (name.length === prefix.length) return false
  const next = name[prefix.length]
  // La char suivante doit démarrer un nouveau token (uppercase letter ou _).
  return next === next.toUpperCase() || next === '_'
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function relativize(absPath: string, rootDir: string): string | null {
  const rel = path.relative(rootDir, absPath).replace(/\\/g, '/')
  if (!rel || rel.startsWith('..')) return null
  return rel
}

function dedup<T>(arr: T[], keyFn: (x: T) => string): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const x of arr) {
    const k = keyFn(x)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(x)
  }
  return out
}

function cmpRef(a: TruthRef, b: TruthRef): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1
  if (a.line !== b.line) return a.line - b.line
  return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0
}

function cmpMirror(a: TruthMirror, b: TruthMirror): number {
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1
  if (a.key !== b.key) return a.key < b.key ? -1 : 1
  if (a.file !== b.file) return a.file < b.file ? -1 : 1
  return a.line - b.line
}

function cmpExposure(a: TruthExposure, b: TruthExposure): number {
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1
  if (a.id !== b.id) return a.id < b.id ? -1 : 1
  return (a.file ?? '').localeCompare(b.file ?? '')
}
