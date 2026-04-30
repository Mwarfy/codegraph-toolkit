/**
 * codegraph_datalog_query(rule_text) — exécute une rule Datalog ad hoc
 * contre les facts émis par `codegraph facts`.
 *
 * Pourquoi : Datalog ne sert pas qu'aux invariants. Les 17 facts émis
 * (`ImportEdge`, `EmitsLiteral`, `SqlForeignKey`, `CycleNode`, …) suffisent
 * à répondre à des questions structurelles ad hoc sans coder un détecteur
 * custom : transitivité, agrégation, anti-jointures, FileTag filters.
 *
 * Le tool prepend le `schema.dl` (qui contient les `.decl`/`.input` des
 * relations existantes), parse la rule user, mergeProgram, load facts,
 * evaluate, et retourne les tuples de la relation output choisie.
 *
 * Cf. Phase 4 axe 1 du plan agent-first.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  parse, mergePrograms, loadFacts, evaluate,
  DatalogError,
} from '@liby-tools/datalog'

export interface DatalogQueryArgs {
  /**
   * Texte de la rule Datalog à exécuter. Doit contenir au moins un
   * `.decl` et une rule. Les relations du schema (`ImportEdge`, etc.)
   * sont disponibles automatiquement — pas besoin de les redéclarer.
   *
   * Exemple :
   *   .decl Result(file:symbol)
   *   Result(F) :- ImportEdge(F, "sentinel-core/src/kernel/event-bus.ts", _).
   */
  rule_text: string
  /**
   * Nom de la relation à observer en sortie. Si fourni : le tool ajoute
   * automatiquement `.output <name>` au programme. Si omis : le tool
   * auto-détecte le DERNIER `.decl` du rule_text et le marque `.output`.
   */
  output_relation?: string
  repo_root?: string
  /**
   * Cap sur le nombre de tuples retournés. Default 200. Au-delà : tronqué
   * (une note "+N more" est ajoutée). Sert à éviter les responses énormes
   * sur une rule transitive non-bornée.
   */
  limit?: number
}

const DEFAULT_LIMIT = 200

export function codegraphDatalogQuery(args: DatalogQueryArgs): { content: string } {
  const repoRoot = args.repo_root ?? process.cwd()
  const limit = args.limit ?? DEFAULT_LIMIT
  const factsDir = path.join(repoRoot, '.codegraph', 'facts')

  // 1. Charger le schema.dl (decls + .input des relations émises).
  const schemaPath = path.join(factsDir, 'schema.dl')
  let schemaText: string
  try {
    schemaText = fs.readFileSync(schemaPath, 'utf-8')
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return errorResponse(
        `No schema.dl at ${schemaPath}. Run \`npx codegraph facts <out>\` ` +
        `or \`npx codegraph analyze\` to emit facts first.`,
      )
    }
    throw err
  }

  // 2. Préparer le rule_text user :
  //    - Si output_relation fourni → append `.output <name>`
  //    - Sinon → auto-detect le dernier `.decl` et marquer `.output`
  let userRule = args.rule_text.trim()
  const outputRel = resolveOutputRelation(userRule, args.output_relation)
  if (!outputRel.name) {
    return errorResponse(outputRel.error!)
  }
  // Append `.output` si pas déjà présent dans le user rule pour cette rel.
  const outputRe = new RegExp(`\\.output\\s+${escapeRegex(outputRel.name)}\\b`)
  if (!outputRe.test(userRule)) {
    userRule += `\n.output ${outputRel.name}\n`
  }

  // 3. Merge schema + user rule.
  let merged
  try {
    merged = mergePrograms([
      { name: 'schema.dl', content: schemaText },
      { name: 'user.dl', content: userRule },
    ])
  } catch (err) {
    if (err instanceof DatalogError) {
      return errorResponse(`Datalog parse/merge error: ${err.message}`)
    }
    throw err
  }

  // 4. Charger les facts (.facts files dans factsDir, dédup auto).
  const factsByRelation = new Map<string, string>()
  const sourcesByRelation = new Map<string, string>()
  for (const decl of merged.decls.values()) {
    if (!decl.isInput) continue
    const factsFile = path.join(factsDir, `${decl.name}.facts`)
    try {
      const content = fs.readFileSync(factsFile, 'utf-8')
      factsByRelation.set(decl.name, content)
      sourcesByRelation.set(decl.name, factsFile)
    } catch (err: any) {
      if (err.code === 'ENOENT') continue            // input rel vide → OK
      throw err
    }
  }

  let db
  try {
    db = loadFacts(merged.decls, { factsByRelation, sourcesByRelation })
  } catch (err) {
    if (err instanceof DatalogError) {
      return errorResponse(`Datalog facts load error: ${err.message}`)
    }
    throw err
  }

  // 5. Eval. allowRecursion: true — la transitivité est un cas d'usage
  //    central de ce tool (chaînes d'imports, taint, héritage). Le runtime
  //    Datalog est stratifié et termine sur fixed-point ; pas de risque
  //    de boucle infinie en théorie. Le `limit` côté response cape la
  //    sortie si jamais une rule explose.
  const start = Date.now()
  let result
  try {
    result = evaluate(merged, db, { allowRecursion: true })
  } catch (err) {
    if (err instanceof DatalogError) {
      return errorResponse(`Datalog eval error: ${err.message}`)
    }
    throw err
  }
  const elapsedMs = Date.now() - start

  // 6. Format.
  const tuples = result.outputs.get(outputRel.name) ?? []
  const truncated = tuples.length > limit
  const shown = truncated ? tuples.slice(0, limit) : tuples

  const lines: string[] = []
  lines.push(`🔍 Datalog query — ${outputRel.name}`)
  lines.push(`  Tuples: ${tuples.length}${truncated ? ` (showing ${limit}, +${tuples.length - limit} truncated)` : ''}`)
  lines.push(`  Eval: ${elapsedMs}ms · facts loaded: ${factsByRelation.size} relations`)
  lines.push('')
  if (shown.length === 0) {
    lines.push('  (no tuples)')
  } else {
    for (const t of shown) {
      const fmt = t.map((v) => typeof v === 'number' ? String(v) : `"${v}"`).join(', ')
      lines.push(`  ${outputRel.name}(${fmt})`)
    }
  }

  return { content: lines.join('\n') }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function errorResponse(msg: string): { content: string } {
  return { content: `❌ ${msg}` }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Détermine la relation à observer.
 *  - Si `provided` fourni : on lui fait confiance (le merge validera son
 *    existence au parsing).
 *  - Sinon : on cherche le DERNIER `.decl Name(...)` dans le rule_text
 *    et on retourne ce nom. Si aucun `.decl` détecté → erreur.
 */
function resolveOutputRelation(
  ruleText: string,
  provided: string | undefined,
): { name: string | null; error?: string } {
  if (provided && provided.length > 0) {
    return { name: provided }
  }
  const declRe = /\.decl\s+([A-Z][A-Za-z0-9_]*)\s*\(/g
  let lastMatch: string | null = null
  let m: RegExpExecArray | null
  while ((m = declRe.exec(ruleText)) !== null) {
    lastMatch = m[1]
  }
  if (!lastMatch) {
    return {
      name: null,
      error:
        `No \`.decl\` found in rule_text and no output_relation provided. ` +
        `Either add \`.decl Result(...)\` to your rule, or pass output_relation explicitly.`,
    }
  }
  return { name: lastMatch }
}
