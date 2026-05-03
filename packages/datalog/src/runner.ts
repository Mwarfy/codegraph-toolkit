// ADR-010
/**
 * High-level runner — wire l'I/O autour du core pur.
 *
 * Trois entrées typiques :
 *   1. `runFromDirs` : un dossier de `.dl` + un dossier de `.facts` →
 *      RunResult. Ce que le boot guard Sentinel utilisera.
 *   2. `runFromString` : pour les tests inline.
 *   3. CLI `datalog run <rules-dir> --facts <facts-dir>` (cf. cli.ts).
 *
 * Le runner concatène plusieurs `.dl` files en un seul programme — pratique
 * pour avoir un fichier par ADR (`adr-017.dl`, `adr-019.dl`, ...) et un
 * `schema.dl` partagé. La concaténation est faite dans l'ORDRE LEX des
 * filenames pour garantir le déterminisme.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { parse, validateProgramReferences } from './parser.js'
import { evaluate, formatProof, type EvalOptions } from './eval.js'
import { loadFactsFromDir, loadFacts } from './facts-loader.js'
import {
  DatalogError,
  type ProofNode, type Program, type RelationDecl,
  type RunResult, type Rule,
} from './types.js'

export interface RunFromDirsOptions extends EvalOptions {
  /**
   * Dossier(s) contenant les `.dl` (rules + schema). Lus en ordre lex
   * dans chaque dossier, puis concaténés dans l'ordre fourni si array.
   *
   * Multi-dir use case : un projet consomme les rules canoniques d'un
   * package partagé (`@liby-tools/invariants-postgres-ts/invariants`) +
   * ses propres rules locales (ADR-specific + grandfathers).
   */
  rulesDir: string | string[]
  /** Dossier contenant les `.facts` (un fichier par relation .input). */
  factsDir: string
}

export async function runFromDirs(opts: RunFromDirsOptions): Promise<{
  program: Program
  result: RunResult
}> {
  const dirs = Array.isArray(opts.rulesDir) ? opts.rulesDir : [opts.rulesDir]
  const program = await loadProgramFromDirs(dirs)
  const db = await loadFactsFromDir(program.decls, opts.factsDir)
  const evalOpts: EvalOptions = {}
  if (opts.recordProofsFor !== undefined) evalOpts.recordProofsFor = opts.recordProofsFor
  if (opts.allowRecursion !== undefined) evalOpts.allowRecursion = opts.allowRecursion
  const result = evaluate(program, db, evalOpts)
  return { program, result }
}

export async function loadProgramFromDir(dir: string): Promise<Program> {
  return loadProgramFromDirs([dir])
}

/**
 * Charge plusieurs dirs `.dl`, dans l'ordre fourni, et les merge en un
 * unique programme. Ordre lex DANS chaque dir, ordre array ENTRE dirs.
 * Pratique pour `[toolkitRules, projectRules]` : les rules canoniques
 * sont chargées d'abord, puis le projet ajoute ses adr-NNN.dl + ses
 * grandfathers facts.
 */
export async function loadProgramFromDirs(dirs: string[]): Promise<Program> {
  if (dirs.length === 0) {
    throw new DatalogError('runner.noRules', 'no rules dir provided')
  }
  // Lit tous les .dl files de tous les dirs en parallèle (I/O indépendantes).
  // Préfixe le nom avec le dir pour disambiguer en cas de doublon de
  // filename dans 2 dirs (erreur claire au merge plutôt qu'écrase).
  const dirEntries = await Promise.all(
    dirs.map(async (dir) => ({
      dir,
      dlFiles: (await fs.readdir(dir)).filter((f) => f.endsWith('.dl')).sort(),
    })),
  )
  const fileTasks: Array<Promise<{ name: string; content: string }>> = []
  for (const { dir, dlFiles } of dirEntries) {
    for (const f of dlFiles) {
      const p = path.join(dir, f)
      fileTasks.push(
        fs.readFile(p, 'utf-8').then((content) => ({
          name: `${path.basename(dir)}/${f}`,
          content,
        })),
      )
    }
  }
  const sources = await Promise.all(fileTasks)
  if (sources.length === 0) {
    throw new DatalogError('runner.noRules', `no .dl files found in ${dirs.join(', ')}`)
  }
  return mergePrograms(sources)
}

/**
 * Parse plusieurs sources `.dl` et merge dans un seul programme.
 *
 * Politique de merge :
 *   - Les decls fusionnent (même `Rel` redéclarée → erreur).
 *   - Les rules accumulent dans l'ordre des fichiers (lex), avec un index
 *     contigu réindexé (rebasé sur l'ordre global).
 *   - Les inline facts accumulent.
 */
export function mergePrograms(
  sources: Array<{ name: string; content: string }>,
): Program {
  const decls = new Map<string, RelationDecl>()
  const rules: Rule[] = []
  const inlineFacts: Program['inlineFacts'] = []
  const aggregates: NonNullable<Program['aggregates']> = []
  let nextIndex = 0

  for (const { name, content } of sources) {
    // Skip per-file ref check : a rule in `adr-017.dl` may reference a
    // `Violation` declared in `schema.dl`. We validate after the merge.
    const sub = parse(content, { source: name, skipReferenceCheck: true })
    for (const [k, d] of sub.decls) {
      if (decls.has(k)) {
        throw new DatalogError('runner.duplicateDecl',
          `relation '${k}' declared in multiple files (already in '${decls.get(k)!.pos.line}', re-declared in '${name}')`,
          d.pos, name)
      }
      decls.set(k, d)
    }
    for (const r of sub.rules) {
      rules.push({ ...r, index: nextIndex++ })
    }
    inlineFacts.push(...sub.inlineFacts)
    if (sub.aggregates) aggregates.push(...sub.aggregates)
  }

  const merged: Program = { decls, rules, inlineFacts, source: '<merged>' }
  if (aggregates.length > 0) merged.aggregates = aggregates
  validateProgramReferences(merged)
  return merged
}

// ─── Pretty printing of a RunResult (text — deterministic) ────────────────

export interface FormatRunOptions {
  /** Print proofs for these relations (must have been recorded at eval). */
  withProofsFor?: string[]
}

/**
 * Texte canonique pour un RunResult. Toutes les relations output sont
 * triées (déjà fait par `evaluate`) ; ici on les sérialise dans un format
 * compact reproductible : `RelName(arg1, arg2)` un par ligne.
 */
export function formatRunResult(
  result: RunResult,
  options: FormatRunOptions = {},
): string {
  const lines: string[] = []
  const outRels = [...result.outputs.keys()].sort()
  for (const relName of outRels) {
    const tuples = result.outputs.get(relName)!
    lines.push(`# ${relName} — ${tuples.length} tuple(s)`)
    for (const t of tuples) {
      lines.push(`${relName}(${t.map(formatVal).join(', ')}).`)
    }
    if (options.withProofsFor?.includes(relName) && result.proofs?.has(relName)) {
      lines.push('')
      lines.push(`# proofs for ${relName}`)
      const proofs = result.proofs.get(relName)!
      // Sort proof keys lex for determinism.
      const sortedKeys = [...proofs.keys()].sort()
      for (const k of sortedKeys) {
        const node = proofs.get(k)!
        lines.push(formatProof(node))
        lines.push('')
      }
    }
    lines.push('')
  }
  return lines.join('\n')
}

function formatVal(v: string | number): string {
  return typeof v === 'number' ? String(v) : `"${v}"`
}

// ─── Programmatic helpers ──────────────────────────────────────────────────

/**
 * `runFromString` — utile pour les tests : fournit le source `.dl` et un
 * objet { relName: tuples[] } pour les facts.
 */
export function runFromString(opts: {
  rules: string
  facts?: Map<string, Array<Array<string | number>>>
  evalOptions?: EvalOptions
}): { program: Program; result: RunResult } {
  const program = parse(opts.rules)
  const factsByRelation = new Map<string, string>()
  if (opts.facts) {
    for (const [relName, tuples] of opts.facts) {
      const lines = tuples.map((t) => t.map(String).join('\t'))
      factsByRelation.set(relName, lines.join('\n'))
    }
  }
  const db = loadFacts(program.decls, { factsByRelation })
  const result = evaluate(program, db, opts.evalOptions ?? {})
  return { program, result }
}

export type { ProofNode }
