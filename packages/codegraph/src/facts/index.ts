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
