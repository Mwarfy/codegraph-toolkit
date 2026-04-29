/**
 * Bottom-up evaluator. Stratifié, sans récursion par défaut (cf. stratify.ts).
 *
 * Stratégie pour une rule `Head :- Body1, Body2, ..., !Neg, ...` :
 *   1. On joint les body atoms positifs dans l'ordre source (left-to-right).
 *      Pour chaque atom : on itère la rel actuelle, on tente d'unifier avec
 *      l'environnement courant. Match → on étend l'environnement.
 *   2. À la fin du join positif, on évalue les atoms négatifs : pour chacun,
 *      on instancie l'atom avec l'environnement et on vérifie qu'AUCUN tuple
 *      de la rel ne matche.
 *   3. Si tout passe, on instancie le head et on insère.
 *
 * Performance : O(N1 × N2 × ... × Nk) dans le pire cas (k = nb body atoms).
 * Pas d'index secondaire pour cette V1 — à ajouter si Sentinel grossit.
 *
 * Déterminisme :
 *   - L'ordre des body atoms n'est PAS réorganisé. La rule auteur contrôle.
 *   - Les facts d'une rel sont parcourus dans leur ordre d'insertion (Map
 *     itère en insertion order, garanti ES2015+).
 *   - L'output est sorti TRIÉ (sortTuples) — ordre d'insertion ne fuit pas.
 *   - Quand `recordProofsFor` est demandé : la 1re dérivation gagne. Comme
 *     l'ordre d'iteration est déterministe, le proof retenu l'est aussi.
 */

import { sortTuples, tupleKey } from './canonical.js'
import { insertTuple } from './facts-loader.js'
import { stratify, type Stratum } from './stratify.js'
import {
  DatalogError,
  type Atom, type Database, type DatalogValue, type Program,
  type ProofNode, type Provenance, type Relation, type RunResult, type Rule,
  type Tuple,
} from './types.js'

export interface EvalOptions {
  /**
   * Liste de noms de relations dont on veut enregistrer les proofs.
   * Typiquement : `['Violation']`. Coût mémoire = N tuples × proof tree.
   */
  recordProofsFor?: string[]
  /** Voir stratify.ts. */
  allowRecursion?: boolean
}

interface ProofRecord {
  ruleIndex: number
  ruleHead: string
  bodyTuples: Array<{ rel: string; tuple: Tuple }>
}

export function evaluate(
  program: Program,
  db: Database,
  options: EvalOptions = {},
): RunResult {
  const t0 = performance.now()
  const recordSet = new Set(options.recordProofsFor ?? [])

  // Add inline facts (parsed from `.dl` source) into the DB.
  for (const fact of program.inlineFacts) {
    const decl = program.decls.get(fact.rel)!
    if (!decl.isInput) {
      throw new DatalogError('eval.inlineFactNotInput',
        `inline fact for non-.input relation '${fact.rel}'`, fact.pos, program.source)
    }
    const tuple: DatalogValue[] = fact.args.map((t) => {
      if (t.kind !== 'const') {
        throw new DatalogError('eval.inlineFactNotConst',
          'inline fact must be all-constant — caught earlier in parser?',
          t.pos, program.source)
      }
      return t.value
    })
    insertTuple(db.relations.get(fact.rel)!, tuple)
  }

  // Provenance map : (relName -> tupleKey -> ProofRecord). Populated only
  // for relations in `recordSet`.
  const provenance = new Map<string, Map<string, ProofRecord>>()
  for (const r of recordSet) provenance.set(r, new Map())

  const strata: Stratum[] = stratify(program, { allowRecursion: options.allowRecursion })

  const stats = {
    rulesExecuted: 0,
    tuplesProduced: 0,
    iterations: 0,
    elapsedMs: 0,
  }

  for (const stratum of strata) {
    // Stratum without rules = pure-input stratum, nothing to do.
    if (stratum.rules.length === 0) continue
    // Saturate this stratum with naïve fixpoint.
    // (Without recursion, one pass over each rule suffices, but we keep the
    //  loop to support `allowRecursion` later.)
    let changed = true
    while (changed) {
      changed = false
      stats.iterations++
      for (const rule of stratum.rules) {
        stats.rulesExecuted++
        const derived = evaluateRule(rule, db, recordSet, provenance, program)
        if (derived > 0) {
          stats.tuplesProduced += derived
          changed = true
        }
      }
      // Without recursion: 1 iteration is enough — if no rule head appears
      // in another rule's body within the same stratum, we won't derive
      // anything new on a second pass. We still loop until stable for safety.
    }
  }

  // Build outputs : only relations marked .output, sorted lex.
  const outputs = new Map<string, Tuple[]>()
  for (const decl of program.decls.values()) {
    if (!decl.isOutput) continue
    const rel = db.relations.get(decl.name)!
    outputs.set(decl.name, sortTuples(rel.tuples))
  }

  // Build proof structure on-demand.
  const proofs = recordSet.size > 0
    ? buildProofs(provenance, db)
    : undefined

  stats.elapsedMs = performance.now() - t0
  const result: RunResult = { outputs, stats }
  if (proofs) result.proofs = proofs
  return result
}

// ─── Single rule evaluation ────────────────────────────────────────────────

/** Evaluate one rule, derive new tuples for its head. Return count. */
function evaluateRule(
  rule: Rule,
  db: Database,
  recordSet: Set<string>,
  provenance: Map<string, Map<string, ProofRecord>>,
  program: Program,
): number {
  const positives = rule.body.filter((a) => !a.negated)
  const negatives = rule.body.filter((a) => a.negated)

  // Iterate all environments that satisfy the positive body.
  const envs: Array<{ env: Env; bodyTuples: Array<{ rel: string; tuple: Tuple }> }> = []
  joinPositive(positives, 0, new Map(), [], db, envs)

  let derived = 0
  for (const { env, bodyTuples } of envs) {
    // Negatives : reject if any matches.
    let rejected = false
    for (const neg of negatives) {
      if (matchesAny(neg, env, db)) { rejected = true; break }
    }
    if (rejected) continue

    // Build the head tuple.
    const headTuple: DatalogValue[] = []
    for (const t of rule.head.args) {
      if (t.kind === 'const') {
        headTuple.push(t.value)
      } else if (t.kind === 'var') {
        const v = env.get(t.name)
        if (v === undefined) {
          throw new DatalogError('eval.unboundHeadVar',
            `head variable '${t.name}' is unbound after body match`,
            t.pos, program.source)
        }
        headTuple.push(v)
      } else {
        throw new DatalogError('eval.wildcardInHead',
          `wildcard in head — caught earlier in parser?`, t.pos, program.source)
      }
    }
    const headRel = db.relations.get(rule.head.rel)!
    if (insertTuple(headRel, headTuple)) {
      derived++
      // Record proof if asked.
      if (recordSet.has(rule.head.rel)) {
        const k = tupleKey(rule.head.rel, headTuple)
        const rec = provenance.get(rule.head.rel)!
        if (!rec.has(k)) {
          rec.set(k, {
            ruleIndex: rule.index,
            ruleHead: rule.head.rel,
            bodyTuples,
          })
        }
      }
    }
  }
  return derived
}

// ─── Joining ───────────────────────────────────────────────────────────────

type Env = Map<string, DatalogValue>

/**
 * Recurse over positive body atoms. For each, iterate the relation, try to
 * unify with the current env. On success, recurse with the extended env.
 *
 * `bodyTuplesAcc` is the trail of (rel, tuple) used to derive the current
 * env — needed for proof recording. We pass it down by COPY at each step
 * to avoid mutation issues; arrays are tiny in practice (<10 atoms typical).
 */
function joinPositive(
  atoms: Atom[],
  i: number,
  env: Env,
  bodyTuplesAcc: Array<{ rel: string; tuple: Tuple }>,
  db: Database,
  out: Array<{ env: Env; bodyTuples: Array<{ rel: string; tuple: Tuple }> }>,
): void {
  if (i === atoms.length) {
    // All positive atoms matched. Snapshot env + trail.
    out.push({
      env: new Map(env),
      bodyTuples: bodyTuplesAcc.slice(),
    })
    return
  }
  const atom = atoms[i]
  const rel = db.relations.get(atom.rel)
  if (!rel) {
    throw new DatalogError('eval.unknownRel',
      `relation '${atom.rel}' not in database`, atom.pos)
  }
  for (const tuple of rel.tuples) {
    const ext = unify(atom, tuple, env)
    if (ext === null) continue
    bodyTuplesAcc.push({ rel: atom.rel, tuple })
    joinPositive(atoms, i + 1, ext, bodyTuplesAcc, db, out)
    bodyTuplesAcc.pop()
  }
}

/**
 * Try to unify `atom.args` against `tuple`. If success, return the extended
 * env (with new bindings). If fail, return null. The base `env` is mutated
 * with new bindings that we WILL revert : we copy on push if needed. Here
 * we mutate then revert — cheaper than allocating a new Map per attempt.
 *
 * To keep it clean we DO allocate: the helper returns a fresh Map only if
 * we need new bindings. If the atom is fully consistent with no new vars
 * needed, we return the original `env`.
 */
function unify(atom: Atom, tuple: Tuple, env: Env): Env | null {
  let ext: Env | null = null
  for (let i = 0; i < atom.args.length; i++) {
    const t = atom.args[i]
    const v = tuple[i]
    if (t.kind === 'const') {
      if (!valueEq(t.value, v)) return null
    } else if (t.kind === 'var') {
      const existing = env.get(t.name)
      if (existing !== undefined) {
        if (!valueEq(existing, v)) return null
      } else {
        // Need to extend.
        if (!ext) ext = new Map(env)
        // Within the same atom, two same-name vars must agree.
        const seenInExt = ext.get(t.name)
        if (seenInExt !== undefined) {
          if (!valueEq(seenInExt, v)) return null
        } else {
          ext.set(t.name, v)
        }
      }
    }
    // wildcard: no constraint
  }
  return ext ?? env
}

/**
 * Negative match : "is there ANY tuple in `atom.rel` that matches the
 * current env?" Returns true if YES (rule must reject).
 */
function matchesAny(atom: Atom, env: Env, db: Database): boolean {
  const rel = db.relations.get(atom.rel)
  if (!rel) {
    throw new DatalogError('eval.unknownRel',
      `relation '${atom.rel}' not in database`, atom.pos)
  }
  outer: for (const tuple of rel.tuples) {
    for (let i = 0; i < atom.args.length; i++) {
      const t = atom.args[i]
      const v = tuple[i]
      if (t.kind === 'const' && !valueEq(t.value, v)) continue outer
      if (t.kind === 'var') {
        const bound = env.get(t.name)
        if (bound === undefined) {
          // Should be impossible — checked at parse (unsafeNegatedVar).
          throw new DatalogError('eval.unboundNegVar',
            `unbound variable '${t.name}' in negated atom`, t.pos)
        }
        if (!valueEq(bound, v)) continue outer
      }
    }
    return true
  }
  return false
}

function valueEq(a: DatalogValue, b: DatalogValue): boolean {
  // typeof check is implicit in === for primitives.
  return a === b
}

// ─── Proof construction ────────────────────────────────────────────────────

/**
 * From the flat `provenance` map, reconstruct ProofNodes (recursively
 * resolving body tuples back to their own provenance if available).
 *
 * If a body tuple is in an `.input` relation, its provenance is `fact`.
 * If it's a derived relation that we DID NOT record, we still emit a
 * `fact`-marked node (with source='derived (not recorded)') — partial
 * proof but always valid up to one level.
 */
function buildProofs(
  provenance: Map<string, Map<string, ProofRecord>>,
  db: Database,
): Map<string, Map<string, ProofNode>> {
  const out = new Map<string, Map<string, ProofNode>>()

  function resolve(rel: string, tuple: Tuple): ProofNode {
    const rec = provenance.get(rel)?.get(tupleKey(rel, tuple))
    if (!rec) {
      const via: Provenance = { kind: 'fact', source: '<input or unrecorded>' }
      return { rel, tuple, via, children: [] }
    }
    const via: Provenance = {
      kind: 'rule',
      ruleIndex: rec.ruleIndex,
      ruleHead: rec.ruleHead,
      bodyTuples: rec.bodyTuples,
    }
    const children = rec.bodyTuples.map((bt) => resolve(bt.rel, bt.tuple))
    return { rel, tuple, via, children }
  }

  for (const [relName, recs] of provenance) {
    const m = new Map<string, ProofNode>()
    for (const [k, _rec] of recs) {
      // Look up the tuple : we need the actual tuple for the node.
      const rel: Relation | undefined = db.relations.get(relName)
      const tuple = rel?.tuples.find((t) => tupleKey(relName, t) === k)
      if (!tuple) continue
      m.set(k, resolve(relName, tuple))
    }
    out.set(relName, m)
  }
  return out
}

/** Format a ProofNode as indented text — handy for CLI output. */
export function formatProof(node: ProofNode, indent = 0): string {
  const pad = '  '.repeat(indent)
  const head = `${node.rel}(${node.tuple.map(formatVal).join(', ')})`
  const lines: string[] = []
  if (node.via.kind === 'fact') {
    lines.push(`${pad}${head}  ← ${node.via.source}`)
  } else {
    lines.push(`${pad}${head}  ← rule #${node.via.ruleIndex} on ${node.via.ruleHead}`)
    for (const c of node.children) {
      lines.push(formatProof(c, indent + 1))
    }
  }
  return lines.join('\n')
}

function formatVal(v: DatalogValue): string {
  return typeof v === 'number' ? String(v) : `"${v}"`
}
