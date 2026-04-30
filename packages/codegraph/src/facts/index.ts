/**
 * Datalog Fact Exporter
 *
 * Sérialise un `GraphSnapshot` codegraph vers le format `.facts` Soufflé
 * (TSV — un tuple par ligne, colonnes séparées par TAB, pas de header,
 * pas de quotes).
 *
 * Le but : exposer ce que codegraph détecte déjà comme faits Datalog que des
 * règles `.dl` peuvent consommer pour exprimer des invariants ADR de manière
 * déclarative. Cf. ADR Datalog (à venir, M5).
 *
 * Pour chaque relation émise :
 *   - `<RelName>.facts` : un fichier TSV, prêt à être chargé par `souffle -F<dir>`
 *   - une déclaration `.decl <RelName>(...)` accumulée dans `schema.dl`,
 *     que les règles peuvent `#include "schema.dl"` ou copier.
 *
 * Soufflé accepte aussi les symbols quotés `"foo bar"` mais le format
 * unquoted-TSV est plus compact et plus déterministe. Les valeurs string
 * sont sanitizées : tab/newline → espace. Toute autre valeur est passée
 * brute. Les entiers sont stringifiés sans quotes.
 *
 * Relations émises en M1 (sous-ensemble) :
 *   File(file:symbol)
 *   FileTag(file:symbol, tag:symbol)
 *   Imports(from:symbol, to:symbol)
 *   ImportEdge(from:symbol, to:symbol, line:number)
 *   EmitsLiteral(file:symbol, line:number, eventName:symbol)
 *   EmitsConstRef(file:symbol, line:number, namespace:symbol, member:symbol)
 *   EmitsDynamic(file:symbol, line:number)
 *   EnvRead(file:symbol, line:number, varName:symbol, hasDefault:symbol)
 *   ModuleFanIn(file:symbol, count:number)
 *
 * Conventions :
 *   - Bools encodés en symbols 'true' / 'false' (Soufflé n'a pas de Bool natif).
 *   - Refs `EVENTS.X` splittées en `(namespace='EVENTS', member='X')` — c'est
 *     la forme la plus utilisable côté règle.
 *   - Refs sans `.` (ex `someVar` vu comme PropertyAccessExpression dégénéré)
 *     restent côté `EmitsDynamic`.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { GraphSnapshot } from '../core/types.js'

export interface ExportFactsOptions {
  /** Dossier cible. Sera créé. Les fichiers existants seront écrasés. */
  outDir: string
}

export interface ExportFactsResult {
  outDir: string
  /** Une entrée par relation : nom + nombre de tuples écrits. */
  relations: Array<{ name: string; tuples: number; file: string }>
  /** Chemin du fichier `schema.dl`. */
  schemaFile: string
}

interface RelationDef {
  name: string
  /** Décl Soufflé : `(file:symbol, line:number)` (sans le keyword `.decl`). */
  decl: string
  /** Tuples : array de colonnes, chaque colonne déjà stringifiée. */
  rows: string[][]
}

export async function exportFacts(
  snapshot: GraphSnapshot,
  options: ExportFactsOptions,
): Promise<ExportFactsResult> {
  const relations: RelationDef[] = []

  // ─── File / FileTag ───────────────────────────────────────────────────
  const fileRel: RelationDef = {
    name: 'File',
    decl: '(file:symbol)',
    rows: [],
  }
  const tagRel: RelationDef = {
    name: 'FileTag',
    decl: '(file:symbol, tag:symbol)',
    rows: [],
  }
  for (const n of snapshot.nodes) {
    if (n.type !== 'file') continue
    fileRel.rows.push([sym(n.id)])
    for (const t of n.tags ?? []) {
      tagRel.rows.push([sym(n.id), sym(t)])
    }
  }
  relations.push(fileRel, tagRel)

  // ─── Imports / ImportEdge ─────────────────────────────────────────────
  // `Imports` est binaire (pratique pour la jointure transitive) ;
  // `ImportEdge` ajoute la ligne pour les règles qui veulent localiser le
  // call site exact.
  const importsRel: RelationDef = {
    name: 'Imports',
    decl: '(from:symbol, to:symbol)',
    rows: [],
  }
  const importEdgeRel: RelationDef = {
    name: 'ImportEdge',
    decl: '(from:symbol, to:symbol, line:number)',
    rows: [],
  }
  const importSeen = new Set<string>()
  for (const e of snapshot.edges) {
    if (e.type !== 'import') continue
    const key = e.from + '\x00' + e.to
    if (!importSeen.has(key)) {
      importsRel.rows.push([sym(e.from), sym(e.to)])
      importSeen.add(key)
    }
    importEdgeRel.rows.push([sym(e.from), sym(e.to), num(e.line ?? 0)])
  }
  relations.push(importsRel, importEdgeRel)

  // ─── EmitsLiteral / EmitsConstRef / EmitsDynamic ──────────────────────
  const emitsLiteralRel: RelationDef = {
    name: 'EmitsLiteral',
    decl: '(file:symbol, line:number, eventName:symbol)',
    rows: [],
  }
  const emitsConstRefRel: RelationDef = {
    name: 'EmitsConstRef',
    decl: '(file:symbol, line:number, namespace:symbol, member:symbol)',
    rows: [],
  }
  const emitsDynamicRel: RelationDef = {
    name: 'EmitsDynamic',
    decl: '(file:symbol, line:number)',
    rows: [],
  }
  for (const s of snapshot.eventEmitSites ?? []) {
    if (s.kind === 'literal' && s.literalValue !== undefined) {
      emitsLiteralRel.rows.push([sym(s.file), num(s.line), sym(s.literalValue)])
    } else if (s.kind === 'eventConstRef' && s.refExpression) {
      const split = splitRef(s.refExpression)
      if (split) {
        emitsConstRefRel.rows.push([sym(s.file), num(s.line), sym(split.ns), sym(split.member)])
      } else {
        emitsDynamicRel.rows.push([sym(s.file), num(s.line)])
      }
    } else {
      emitsDynamicRel.rows.push([sym(s.file), num(s.line)])
    }
  }
  relations.push(emitsLiteralRel, emitsConstRefRel, emitsDynamicRel)

  // ─── EnvRead ──────────────────────────────────────────────────────────
  const envReadRel: RelationDef = {
    name: 'EnvRead',
    decl: '(file:symbol, line:number, varName:symbol, hasDefault:symbol)',
    rows: [],
  }
  // EnvReadWrapped — uniquement les sites où process.env.X est passé
  // directement comme arg d'un call (parseInt, Number, envInt, …). Le 4e
  // arg est le nom du callee. Sert à ADR-019.
  const envReadWrappedRel: RelationDef = {
    name: 'EnvReadWrapped',
    decl: '(file:symbol, line:number, varName:symbol, wrappedIn:symbol)',
    rows: [],
  }
  for (const u of snapshot.envUsage ?? []) {
    for (const r of u.readers) {
      envReadRel.rows.push([
        sym(r.file),
        num(r.line),
        sym(u.name),
        sym(r.hasDefault ? 'true' : 'false'),
      ])
      if (r.wrappedIn) {
        envReadWrappedRel.rows.push([
          sym(r.file),
          num(r.line),
          sym(u.name),
          sym(r.wrappedIn),
        ])
      }
    }
  }
  relations.push(envReadRel, envReadWrappedRel)

  // ─── OauthScopeLiteral ────────────────────────────────────────────────
  const oauthScopeRel: RelationDef = {
    name: 'OauthScopeLiteral',
    decl: '(file:symbol, line:number, scope:symbol)',
    rows: [],
  }
  for (const s of snapshot.oauthScopeLiterals ?? []) {
    oauthScopeRel.rows.push([sym(s.file), num(s.line), sym(s.scope)])
  }
  relations.push(oauthScopeRel)

  // ─── ModuleFanIn ──────────────────────────────────────────────────────
  const fanInRel: RelationDef = {
    name: 'ModuleFanIn',
    decl: '(file:symbol, count:number)',
    rows: [],
  }
  for (const m of snapshot.moduleMetrics ?? []) {
    fanInRel.rows.push([sym(m.file), num(m.fanIn)])
  }
  relations.push(fanInRel)

  // ─── SQL Schema (Phase 2 enrichissement) ──────────────────────────────
  // Émet 5 relations dérivées de l'extracteur sql-schema (parse des
  // migrations Postgres). Source des invariants type "FK doit être
  // indexé" exécutables via Datalog.
  const sqlTableRel: RelationDef = {
    name: 'SqlTable',
    decl: '(name:symbol, file:symbol, line:number)',
    rows: [],
  }
  const sqlColumnRel: RelationDef = {
    name: 'SqlColumn',
    decl: '(table:symbol, column:symbol, type:symbol, file:symbol, line:number)',
    rows: [],
  }
  const sqlForeignKeyRel: RelationDef = {
    name: 'SqlForeignKey',
    decl: '(fromTable:symbol, fromCol:symbol, toTable:symbol, toCol:symbol, file:symbol, line:number)',
    rows: [],
  }
  const sqlIndexRel: RelationDef = {
    name: 'SqlIndex',
    decl: '(name:symbol, table:symbol, firstCol:symbol, file:symbol, line:number)',
    rows: [],
  }
  const sqlFkWithoutIndexRel: RelationDef = {
    name: 'SqlFkWithoutIndex',
    decl: '(fromTable:symbol, fromCol:symbol, toTable:symbol, toCol:symbol)',
    rows: [],
  }
  const sqlPrimaryKeyRel: RelationDef = {
    name: 'SqlPrimaryKey',
    decl: '(table:symbol, column:symbol, file:symbol, line:number)',
    rows: [],
  }
  if (snapshot.sqlSchema) {
    for (const t of snapshot.sqlSchema.tables) {
      sqlTableRel.rows.push([sym(t.name), sym(t.file), num(t.line)])
      for (const c of t.columns) {
        sqlColumnRel.rows.push([
          sym(t.name),
          sym(c.name),
          sym(c.type),
          sym(t.file),
          num(c.line),
        ])
      }
    }
    for (const fk of snapshot.sqlSchema.foreignKeys) {
      sqlForeignKeyRel.rows.push([
        sym(fk.fromTable),
        sym(fk.fromColumn),
        sym(fk.toTable),
        sym(fk.toColumn),
        sym(fk.file),
        num(fk.line),
      ])
    }
    for (const idx of snapshot.sqlSchema.indexes) {
      // Skip les indexes sur expression (firstColumn=null) — pas
      // utilisables pour le matching FK→index.
      if (idx.firstColumn === null) continue
      sqlIndexRel.rows.push([
        sym(idx.name),
        sym(idx.table),
        sym(idx.firstColumn),
        sym(idx.file),
        num(idx.line),
      ])
    }
    // Dédupe les FkWithoutIndex (dans le snapshot ils peuvent apparaître
    // 2× quand la même FK est définie dans deux fichiers — schema.sql +
    // migration source). Pour le datalog on veut une violation par paire
    // unique (fromTable, fromCol).
    const seenFkPair = new Set<string>()
    for (const fk of snapshot.sqlSchema.fkWithoutIndex) {
      const key = fk.fromTable + '\x00' + fk.fromColumn
      if (seenFkPair.has(key)) continue
      seenFkPair.add(key)
      sqlFkWithoutIndexRel.rows.push([
        sym(fk.fromTable),
        sym(fk.fromColumn),
        sym(fk.toTable),
        sym(fk.toColumn),
      ])
    }
    for (const pk of snapshot.sqlSchema.primaryKeys ?? []) {
      sqlPrimaryKeyRel.rows.push([
        sym(pk.table),
        sym(pk.column),
        sym(pk.file),
        num(pk.line),
      ])
    }
  }
  relations.push(sqlTableRel, sqlColumnRel, sqlForeignKeyRel, sqlIndexRel, sqlFkWithoutIndexRel, sqlPrimaryKeyRel)

  // ─── CycleNode ────────────────────────────────────────────────────────
  // Pour chaque cycle détecté (Tarjan SCC sur graphe combiné import + event +
  // queue + dynamic-load), émet un tuple par fichier participant. Le champ
  // `gated` indique si le cycle est gated par un gate explicite (ex
  // `if (env.X)` autour de l'import dynamique) — un cycle gated reste un
  // cycle au sens topo mais est intentionnel donc PAS à bloquer.
  // Source: ADR-022 ratchet pattern, axe 5 enrichissement post-Phase-C.
  const cycleNodeRel: RelationDef = {
    name: 'CycleNode',
    decl: '(file:symbol, cycleId:symbol, gated:symbol)',
    rows: [],
  }
  const cycleNodeSeen = new Set<string>()
  for (const c of snapshot.cycles ?? []) {
    const gatedSym = c.gated ? 'true' : 'false'
    for (const file of c.nodes) {
      // dedupe : un fichier peut apparaître plusieurs fois dans un cycle
      // listé en path (premier == dernier). On émet un tuple unique
      // par (file, cycleId).
      const key = file + '\x00' + c.id
      if (cycleNodeSeen.has(key)) continue
      cycleNodeSeen.add(key)
      cycleNodeRel.rows.push([sym(file), sym(c.id), gatedSym])
    }
  }
  relations.push(cycleNodeRel)

  // ─── SymbolCallEdge / SymbolSignature ────────────────────────────────
  // Phase 4 axe 2 : path queries CFG-level via Datalog. Émet les call edges
  // typés et les signatures pour permettre des rules taint-analysis lite
  // (auth-before-write, validate-before-db, etc.) sans coder un détecteur
  // dédié.
  // Source : snapshot.typedCalls (callEdges + signatures).
  const symbolCallEdgeRel: RelationDef = {
    name: 'SymbolCallEdge',
    decl: '(fromFile:symbol, fromSymbol:symbol, toFile:symbol, toSymbol:symbol, line:number)',
    rows: [],
  }
  const symbolSignatureRel: RelationDef = {
    name: 'SymbolSignature',
    decl: '(file:symbol, name:symbol, kind:symbol, line:number)',
    rows: [],
  }
  if (snapshot.typedCalls) {
    for (const sig of snapshot.typedCalls.signatures) {
      symbolSignatureRel.rows.push([
        sym(sig.file),
        sym(sig.exportName),
        sym(sig.kind),
        num(sig.line),
      ])
    }
    for (const edge of snapshot.typedCalls.callEdges) {
      // `from` / `to` sont au format "file:symbolName". Le séparateur est
      // le DERNIER `:` (les noms TS d'export ne contiennent pas `:`).
      const fromSplit = splitFileSymbol(edge.from)
      const toSplit = splitFileSymbol(edge.to)
      if (!fromSplit || !toSplit) continue   // edge dégradé — skip
      symbolCallEdgeRel.rows.push([
        sym(fromSplit.file),
        sym(fromSplit.symbol),
        sym(toSplit.file),
        sym(toSplit.symbol),
        num(edge.line),
      ])
    }
  }
  relations.push(symbolCallEdgeRel, symbolSignatureRel)

  // ─── EntryPoint ──────────────────────────────────────────────────────
  // Source : snapshot.dataFlows[].entry. Dédupe par (file, kind, id) car
  // un handler peut apparaître plusieurs fois (downstream chains).
  const entryPointRel: RelationDef = {
    name: 'EntryPoint',
    decl: '(file:symbol, kind:symbol, id:symbol)',
    rows: [],
  }
  const entryPointSeen = new Set<string>()
  const collectEntries = (flows: Array<{ entry: { kind: string; id: string; file: string }; downstream?: any[] }>): void => {
    for (const f of flows) {
      const key = f.entry.file + '\x00' + f.entry.kind + '\x00' + f.entry.id
      if (!entryPointSeen.has(key)) {
        entryPointSeen.add(key)
        entryPointRel.rows.push([
          sym(f.entry.file),
          sym(f.entry.kind),
          sym(f.entry.id),
        ])
      }
      if (f.downstream && f.downstream.length > 0) collectEntries(f.downstream)
    }
  }
  if (snapshot.dataFlows) {
    collectEntries(snapshot.dataFlows as any)
  }
  relations.push(entryPointRel)

  // ─── EvalCall ────────────────────────────────────────────────────────
  // Phase 4 Tier 1 : `eval(...)` et `new Function(...)` — vecteurs RCE
  // classiques. Source : extractors/eval-calls.ts.
  const evalCallRel: RelationDef = {
    name: 'EvalCall',
    decl: '(file:symbol, line:number, kind:symbol, containingSymbol:symbol)',
    rows: [],
  }
  for (const ec of snapshot.evalCalls ?? []) {
    evalCallRel.rows.push([
      sym(ec.file),
      num(ec.line),
      sym(ec.kind),
      sym(ec.containingSymbol),
    ])
  }
  relations.push(evalCallRel)

  // ─── HardcodedSecret (Tier 2) ────────────────────────────────────────
  const hardcodedSecretRel: RelationDef = {
    name: 'HardcodedSecret',
    decl: '(file:symbol, line:number, context:symbol, trigger:symbol, entropy:number)',
    rows: [],
  }
  for (const s of snapshot.hardcodedSecrets ?? []) {
    hardcodedSecretRel.rows.push([
      sym(s.file),
      num(s.line),
      sym(s.context || '_'),
      sym(s.trigger),
      num(Math.round(s.entropy * 100)),  // entropy * 100 pour rester en int
    ])
  }
  relations.push(hardcodedSecretRel)

  // ─── BooleanParam (Tier 2) ───────────────────────────────────────────
  const booleanParamRel: RelationDef = {
    name: 'BooleanParam',
    decl: '(file:symbol, line:number, name:symbol, paramName:symbol, paramIndex:number, totalParams:number)',
    rows: [],
  }
  for (const b of snapshot.booleanParams ?? []) {
    booleanParamRel.rows.push([
      sym(b.file),
      num(b.line),
      sym(b.name),
      sym(b.paramName),
      num(b.paramIndex),
      num(b.totalParams),
    ])
  }
  relations.push(booleanParamRel)

  // ─── Write to disk ────────────────────────────────────────────────────
  await fs.mkdir(options.outDir, { recursive: true })

  const result: ExportFactsResult = {
    outDir: options.outDir,
    relations: [],
    schemaFile: path.join(options.outDir, 'schema.dl'),
  }

  for (const rel of relations) {
    const factPath = path.join(options.outDir, `${rel.name}.facts`)
    const content = rel.rows.map((cols) => cols.join('\t')).join('\n')
    // Soufflé attend que les .facts existent même vides (sinon il warn).
    await fs.writeFile(factPath, content + (content.length > 0 ? '\n' : ''))
    result.relations.push({ name: rel.name, tuples: rel.rows.length, file: factPath })
  }

  // ─── schema.dl ────────────────────────────────────────────────────────
  // Header + .decl + .input pour chaque relation. Les règles `.dl`
  // utilisateur peuvent `#include "schema.dl"` et écrire seulement les
  // règles + .output Violation.
  const lines: string[] = []
  lines.push(`// AUTO-GÉNÉRÉ par @liby-tools/codegraph 'codegraph facts'.`)
  lines.push(`// Source : snapshot ${snapshot.commitHash ?? '(no-commit)'} @ ${snapshot.generatedAt}.`)
  lines.push(`// NE PAS éditer à la main — relancer 'codegraph facts <out>' pour régénérer.`)
  lines.push('')
  for (const rel of relations) {
    lines.push(`.decl ${rel.name}${rel.decl}`)
    lines.push(`.input ${rel.name}`)
  }
  await fs.writeFile(result.schemaFile, lines.join('\n') + '\n')

  return result
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Sanitize une valeur string pour le format `.facts` Soufflé non-quoté :
 * remplace les tabs et newlines par un espace. Les autres caractères
 * (espaces, ponctuation, accents) sont préservés.
 */
function sym(value: string): string {
  return value.replace(/[\t\n\r]/g, ' ')
}

function num(n: number): string {
  return String(Math.trunc(n))
}

/**
 * Splitte un id symbole `"file/path.ts:symbolName"` en `{ file, symbol }`.
 * Retourne null si pas de `:` (id dégénéré). Le séparateur est le DERNIER
 * `:` (un path peut en théorie contenir `:`, en pratique non — paths POSIX).
 */
function splitFileSymbol(id: string): { file: string; symbol: string } | null {
  const idx = id.lastIndexOf(':')
  if (idx <= 0 || idx === id.length - 1) return null
  return { file: id.slice(0, idx), symbol: id.slice(idx + 1) }
}

/**
 * Splitte `EVENTS.RENDER_COMPLETED` en `{ ns: 'EVENTS', member: 'RENDER_COMPLETED' }`.
 * Retourne null si l'expression n'est pas un property access simple à 1 niveau
 * (ex: `obj.events.X`).
 */
function splitRef(expr: string): { ns: string; member: string } | null {
  const parts = expr.split('.')
  if (parts.length !== 2) return null
  const [ns, member] = parts
  if (!ns || !member) return null
  return { ns, member }
}
