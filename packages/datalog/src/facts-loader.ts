// ADR-010
/**
 * `.facts` TSV loader.
 *
 * Format attendu (compatible Soufflé) :
 *   - Un tuple par ligne
 *   - Colonnes séparées par TAB
 *   - Pas de header
 *   - Pas de quotes
 *   - Lignes vides = ignorées
 *   - Caractères de contrôle (\r dans le contenu, \0, …) = rejet
 *
 * Coercion :
 *   - Une colonne déclarée `number` doit matcher /^-?\d+$/. Sinon erreur
 *     avec line:col du fichier facts.
 *   - Une colonne déclarée `symbol` reste string telle quelle (post-trim
 *     interdit — un trailing space EST significatif et le caller doit le
 *     gérer côté exporter).
 *
 * Le loader est PURE — pas d'I/O ici. Le caller fournit le contenu déjà lu.
 * Cf. `runner.ts` pour le wire avec le filesystem.
 */

import {
  DatalogError,
  type ColumnType, type Database, type DatalogValue,
  type Relation, type RelationDecl, type Tuple,
} from './types.js'
import { tupleKey } from './canonical.js'

export interface LoadFactsOptions {
  /** Map(relName → contenu TSV brut). Les rels non-input sont ignorées. */
  factsByRelation: Map<string, string>
  /** Source filename pour les errors (ex: 'EmitsLiteral.facts'). */
  sourcesByRelation?: Map<string, string>
}

/**
 * Charge tous les facts en input dans une `Database` neuve. Les relations
 * non `.input` sont créées vides (pour que l'évaluateur puisse y écrire).
 */
export function loadFacts(
  decls: Map<string, RelationDecl>,
  options: LoadFactsOptions,
): Database {
  const relations = new Map<string, Relation>()

  // Initialise toutes les rels (vides). L'évaluateur s'attend à les trouver.
  for (const decl of decls.values()) {
    relations.set(decl.name, {
      name: decl.name,
      arity: decl.columns.length,
      tuples: [],
      index: new Map(),
    })
  }

  for (const [relName, content] of options.factsByRelation) {
    const decl = decls.get(relName)
    if (!decl) {
      throw new DatalogError('load.unknownRel',
        `facts provided for undeclared relation '${relName}'`)
    }
    if (!decl.isInput) {
      throw new DatalogError('load.notInput',
        `relation '${relName}' is not declared as .input — refusing facts`)
    }
    const source = options.sourcesByRelation?.get(relName) ?? `${relName}.facts`
    const rel = relations.get(relName)!
    parseTsv(content, decl, source, rel)
  }

  return { relations }
}

function parseTsv(
  content: string,
  decl: RelationDecl,
  source: string,
  rel: Relation,
): void {
  const lines = content.split('\n')
  const arity = decl.columns.length
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const raw = lines[lineIdx]
    if (raw.length === 0) continue                   // skip empty
    if (raw === '\r') continue                       // tolère trailing CR isolé

    // Reject control chars (tabs are ok, that's the separator)
    for (let c = 0; c < raw.length; c++) {
      const code = raw.charCodeAt(c)
      if (code < 0x20 && code !== 0x09) {            // 0x09 = \t
        throw new DatalogError('load.controlChar',
          `unexpected control character (code ${code}) in ${source}`,
          { line: lineIdx + 1, col: c + 1 }, source)
      }
    }

    const cols = raw.split('\t')
    if (cols.length !== arity) {
      throw new DatalogError('load.arityMismatch',
        `expected ${arity} columns for '${decl.name}', got ${cols.length} in ${source}`,
        { line: lineIdx + 1, col: 1 }, source)
    }

    const tuple: DatalogValue[] = []
    for (let c = 0; c < arity; c++) {
      tuple.push(coerce(cols[c], decl.columns[c].type, source, lineIdx + 1, c + 1))
    }

    const key = tupleKey(decl.name, tuple)
    if (!rel.index.has(key)) {
      rel.index.set(key, rel.tuples.length)
      rel.tuples.push(tuple)
    }
    // duplicate row → silently dedup. Soufflé fait pareil.
  }
}

function coerce(
  raw: string, type: ColumnType,
  source: string, line: number, col: number,
): DatalogValue {
  if (type === 'number') {
    if (!/^-?\d+$/.test(raw)) {
      throw new DatalogError('load.badNumber',
        `expected integer, got '${raw}'`,
        { line, col }, source)
    }
    const n = parseInt(raw, 10)
    if (!Number.isSafeInteger(n)) {
      throw new DatalogError('load.numberOverflow',
        `integer '${raw}' exceeds safe range`,
        { line, col }, source)
    }
    return n
  }
  return raw
}

// ─── Utilities ──────────────────────────────────────────────────────────────

/**
 * Insert un tuple dans une relation. Préserve dédup. Retourne `true` si
 * inséré, `false` si déjà présent. Utilisé par l'évaluateur.
 */
export function insertTuple(rel: Relation, tuple: Tuple): boolean {
  const key = tupleKey(rel.name, tuple)
  if (rel.index.has(key)) return false
  rel.index.set(key, rel.tuples.length)
  rel.tuples.push(tuple)
  return true
}

/**
 * Charge des facts directement depuis un dossier (helper). Pour le PURE
 * core on garde `loadFacts` — ce wrapper est pour le runner.
 */
export async function loadFactsFromDir(
  decls: Map<string, RelationDecl>,
  dir: string,
): Promise<Database> {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const factsByRelation = new Map<string, string>()
  const sourcesByRelation = new Map<string, string>()
  for (const decl of decls.values()) {
    if (!decl.isInput) continue
    const file = path.join(dir, `${decl.name}.facts`)
    try {
      const content = await fs.readFile(file, 'utf-8')
      factsByRelation.set(decl.name, content)
      sourcesByRelation.set(decl.name, file)
    } catch (err: any) {
      if (err.code === 'ENOENT') continue            // empty input rel — OK
      throw err
    }
  }
  return loadFacts(decls, { factsByRelation, sourcesByRelation })
}
