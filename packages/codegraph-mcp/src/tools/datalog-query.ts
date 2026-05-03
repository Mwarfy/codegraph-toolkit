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
  mergePrograms, loadFacts, evaluate,
  formatProof, tupleKey,
  DatalogError,
  type ProofNode,
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
  /**
   * Si true, capture et affiche le proof tree de chaque tuple output
   * (pourquoi ce tuple a été dérivé). Coût eval +5-10ms typique. Utile
   * pour debug ou pour comprendre une violation composite multi-relation
   * (Tier 12).
   */
  with_proof?: boolean
}

const DEFAULT_LIMIT = 200

/** Erreur user-facing levée par les helpers — captée à la racine. */
class QueryFailure extends Error {}

export function codegraphDatalogQuery(args: DatalogQueryArgs): { content: string } {
  const repoRoot = args.repo_root ?? process.cwd()
  const limit = args.limit ?? DEFAULT_LIMIT
  const factsDir = path.join(repoRoot, '.codegraph', 'facts')

  try {
    const schemaText = loadSchemaText(factsDir)
    const { userRule, outputName } = prepareUserRule(args.rule_text, args.output_relation)
    const merged = mergeSchemaAndUser(schemaText, userRule)
    const { db, factsCount } = loadFactsForDecls(merged, factsDir)
    const { result, elapsedMs } = runEvaluation(merged, db, outputName, args.with_proof ?? false)
    return { content: formatQueryResult(result, outputName, limit, elapsedMs, factsCount, args.with_proof ?? false) }
  } catch (err) {
    if (err instanceof QueryFailure) return errorResponse(err.message)
    throw err
  }
}

// ─── Phase 1: load schema.dl ────────────────────────────────────────────────

function loadSchemaText(factsDir: string): string {
  const schemaPath = path.join(factsDir, 'schema.dl')
  try {
    return fs.readFileSync(schemaPath, 'utf-8')
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      throw new QueryFailure(
        `No schema.dl at ${schemaPath}. Run \`npx codegraph facts <out>\` ` +
        `or \`npx codegraph analyze\` to emit facts first.`,
      )
    }
    throw err
  }
}

// ─── Phase 2: prepare user rule with .output ────────────────────────────────

function prepareUserRule(
  ruleText: string,
  providedOutputRelation: string | undefined,
): { userRule: string; outputName: string } {
  let userRule = ruleText.trim()
  const outputRel = resolveOutputRelation(userRule, providedOutputRelation)
  if (!outputRel.name) throw new QueryFailure(outputRel.error!)
  const outputRe = new RegExp(`\\.output\\s+${escapeRegex(outputRel.name)}\\b`)
  if (!outputRe.test(userRule)) {
    userRule += `\n.output ${outputRel.name}\n`
  }
  return { userRule, outputName: outputRel.name }
}

// ─── Phase 3: merge schema + user rule ──────────────────────────────────────

type MergedProgram = ReturnType<typeof mergePrograms>

function mergeSchemaAndUser(schemaText: string, userRule: string): MergedProgram {
  return runOrFail(
    () => mergePrograms([
      { name: 'schema.dl', content: schemaText },
      { name: 'user.dl', content: userRule },
    ]),
    'Datalog parse/merge error',
  )
}

// ─── Phase 4: load facts files ──────────────────────────────────────────────

function loadFactsForDecls(
  merged: MergedProgram,
  factsDir: string,
): { db: ReturnType<typeof loadFacts>; factsCount: number } {
  const factsByRelation = new Map<string, string>()
  const sourcesByRelation = new Map<string, string>()
  for (const decl of merged.decls.values()) {
    if (!decl.isInput) continue
    const factsFile = path.join(factsDir, `${decl.name}.facts`)
    try {
      factsByRelation.set(decl.name, fs.readFileSync(factsFile, 'utf-8'))
      sourcesByRelation.set(decl.name, factsFile)
    } catch (err: any) {
      if (err.code === 'ENOENT') continue            // input rel vide → OK
      throw err
    }
  }
  const db = runOrFail(
    () => loadFacts(merged.decls, { factsByRelation, sourcesByRelation }),
    'Datalog facts load error',
  )
  return { db, factsCount: factsByRelation.size }
}

// ─── Phase 5: evaluate ──────────────────────────────────────────────────────

/**
 * allowRecursion: true — la transitivité est un cas d'usage central de ce tool
 * (chaînes d'imports, taint, héritage). Le runtime Datalog est stratifié et
 * termine sur fixed-point. Le `limit` côté response cape la sortie si jamais
 * une rule explose.
 */
function runEvaluation(
  merged: MergedProgram,
  db: ReturnType<typeof loadFacts>,
  outputName: string,
  withProof: boolean,
): { result: ReturnType<typeof evaluate>; elapsedMs: number } {
  const start = Date.now()
  const evalOpts: Parameters<typeof evaluate>[2] = { allowRecursion: true }
  if (withProof) evalOpts.recordProofsFor = [outputName]
  const result = runOrFail(() => evaluate(merged, db, evalOpts), 'Datalog eval error')
  return { result, elapsedMs: Date.now() - start }
}

// ─── Phase 6: format text output ────────────────────────────────────────────

function formatQueryResult(
  result: ReturnType<typeof evaluate>,
  outputName: string,
  limit: number,
  elapsedMs: number,
  factsCount: number,
  withProof: boolean,
): string {
  const tuples = result.outputs.get(outputName) ?? []
  const truncated = tuples.length > limit
  const shown = truncated ? tuples.slice(0, limit) : tuples
  const proofs = withProof ? result.proofs?.get(outputName) : undefined

  const lines: string[] = []
  lines.push(`🔍 Datalog query — ${outputName}`)
  lines.push(`  Tuples: ${tuples.length}${truncated ? ` (showing ${limit}, +${tuples.length - limit} truncated)` : ''}`)
  lines.push(`  Eval: ${elapsedMs}ms · facts loaded: ${factsCount} relations${withProof ? ' · proofs recorded' : ''}`)
  lines.push('')
  if (shown.length === 0) {
    lines.push('  (no tuples)')
    return lines.join('\n')
  }
  for (const t of shown) {
    const fmt = t.map((v) => typeof v === 'number' ? String(v) : `"${v}"`).join(', ')
    lines.push(`  ${outputName}(${fmt})`)
    if (proofs) appendProofLines(proofs, outputName, t, lines)
  }
  return lines.join('\n')
}

/** Tier 12 : affiche le proof path (chaîne de dérivation) sous le tuple. */
function appendProofLines(
  proofs: Map<string, ProofNode>,
  outputName: string,
  tuple: ReadonlyArray<string | number>,
  lines: string[],
): void {
  const proof = proofs.get(tupleKey(outputName, tuple))
  if (!proof) return
  const proofText = formatProof(proof)
  for (const pl of proofText.split('\n').slice(0, 6)) {
    if (pl.trim().length > 0) lines.push(`    ${pl}`)
  }
}

/**
 * Wrap un call qui peut throw DatalogError dans une QueryFailure user-facing.
 * Tout autre throw est re-throw inchangé.
 */
function runOrFail<T>(fn: () => T, prefix: string): T {
  try {
    return fn()
  } catch (err) {
    if (err instanceof DatalogError) throw new QueryFailure(`${prefix}: ${err.message}`)
    throw err
  }
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
