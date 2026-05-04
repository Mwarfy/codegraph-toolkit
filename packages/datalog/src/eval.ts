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
  type AggregateDef, type Atom, type Constraint,
  type Database, type DatalogValue, type Program,
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

interface EvalStats {
  rulesExecuted: number
  tuplesProduced: number
  iterations: number
  elapsedMs: number
}

/**
 * Add inline facts (parsed from `.dl` source) into the DB.
 * Acceptes sur n'importe quelle relation declaree — utile pour les
 * lookup tables (`.decl ForbiddenCoercion` + facts inline) et pour
 * pre-remplir une relation aussi ecrite par des rules.
 */
function addInlineFacts(program: Program, db: Database): void {
  for (const fact of program.inlineFacts) {
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
}

function runStrata(
  strata: Stratum[],
  db: Database,
  recordSet: Set<string>,
  provenance: Map<string, Map<string, ProofRecord>>,
  program: Program,
  stats: EvalStats,
): void {
  for (const stratum of strata) {
    if (stratum.rules.length === 0) continue
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
    }
  }
}

function computeGroupCols(pattern: Atom['args']): number[] {
  const groupCols: number[] = []
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i].kind === 'var') groupCols.push(i)
  }
  return groupCols
}

function initBucketAccum(kind: 'count' | 'sum' | 'min' | 'max'): number {
  if (kind === 'count' || kind === 'sum') return 0
  if (kind === 'min') return Number.POSITIVE_INFINITY
  return Number.NEGATIVE_INFINITY
}

function rowMatchesPattern(row: Tuple, pattern: Atom['args']): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const term = pattern[i]
    if (term.kind === 'const' && row[i] !== term.value) return false
  }
  return true
}

function applyAggregateValue(
  bucket: { keyTuple: DatalogValue[]; accum: number },
  agg: AggregateDef,
  row: Tuple,
  valueColIdx: number,
  program: Program,
): void {
  if (agg.kind === 'count') {
    bucket.accum += 1
    return
  }
  const v = row[valueColIdx]
  if (typeof v !== 'number') {
    const valueColName = agg.pattern[valueColIdx].kind === 'var'
      ? (agg.pattern[valueColIdx] as { name: string }).name : '?'
    throw new DatalogError('eval.aggregateNonNumber',
      `'${agg.kind}' aggregate '${agg.resultRel}': value column '${valueColName}' must be number, got ${typeof v} '${v}'`,
      agg.pos, program.source)
  }
  if (agg.kind === 'sum') bucket.accum += v
  else if (agg.kind === 'min') bucket.accum = Math.min(bucket.accum, v)
  else if (agg.kind === 'max') bucket.accum = Math.max(bucket.accum, v)
}

function deriveAggregateValueColIdx(agg: AggregateDef, groupCols: number[], program: Program): number {
  if (agg.kind === 'count') return -1
  if (groupCols.length === 0) {
    throw new DatalogError('eval.aggregateNoValueCol',
      `'${agg.kind}' aggregate '${agg.resultRel}' needs at least one value variable in source pattern`,
      agg.pos, program.source)
  }
  const valueColIdx = groupCols[groupCols.length - 1]
  // La last group var devient la value col — on l'enleve des group keys.
  groupCols.pop()
  return valueColIdx
}

function executeAggregate(agg: AggregateDef, db: Database, program: Program): void {
  const sourceRel = db.relations.get(agg.sourceRel)
  if (!sourceRel) {
    throw new DatalogError('eval.aggregateUnknownSource',
      `aggregate '${agg.resultRel}' references unknown source '${agg.sourceRel}'`,
      agg.pos, program.source)
  }
  const groupCols = computeGroupCols(agg.pattern)
  const valueColIdx = deriveAggregateValueColIdx(agg, groupCols, program)

  if (groupCols.length !== agg.resultDecl.columns.length - 1) {
    throw new DatalogError('eval.aggregateArityMismatch',
      `aggregate '${agg.resultRel}': ${groupCols.length} group var(s) but result has ${agg.resultDecl.columns.length - 1} non-aggregate col(s)`,
      agg.pos, program.source)
  }

  const buckets = new Map<string, { keyTuple: DatalogValue[]; accum: number }>()
  for (const row of sourceRel.tuples) {
    if (!rowMatchesPattern(row, agg.pattern)) continue
    const keyTuple = groupCols.map((i) => row[i])
    const key = keyTuple.map((v) => String(v)).join('\x00')
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { keyTuple: keyTuple.slice(), accum: initBucketAccum(agg.kind) }
      buckets.set(key, bucket)
    }
    applyAggregateValue(bucket, agg, row, valueColIdx, program)
  }

  const resultRel = db.relations.get(agg.resultRel)
  if (!resultRel) {
    throw new DatalogError('eval.aggregateMissingResultRel',
      `aggregate result relation '${agg.resultRel}' not initialized in DB — bug?`,
      agg.pos, program.source)
  }
  for (const bucket of buckets.values()) {
    insertTuple(resultRel, [...bucket.keyTuple, bucket.accum])
  }
}

export function evaluate(
  program: Program,
  db: Database,
  options: EvalOptions = {},
): RunResult {
  const t0 = performance.now()
  const recordSet = new Set(options.recordProofsFor ?? [])

  addInlineFacts(program, db)

  // Provenance map : (relName -> tupleKey -> ProofRecord). Populated only
  // for relations in `recordSet`.
  const provenance = new Map<string, Map<string, ProofRecord>>()
  for (const r of recordSet) provenance.set(r, new Map())

  const strata: Stratum[] = stratify(program, { allowRecursion: options.allowRecursion })

  const stats: EvalStats = {
    rulesExecuted: 0,
    tuplesProduced: 0,
    iterations: 0,
    elapsedMs: 0,
  }

  runStrata(strata, db, recordSet, provenance, program, stats)

  // Aggregates (Tier 14 alt2) post-strates : count/sum/min/max sur les
  // relations materialisees. Re-run strata apres pour que les rules
  // consommant les results d'aggregate puissent deriver leurs heads.
  if (program.aggregates && program.aggregates.length > 0) {
    for (const agg of program.aggregates) {
      executeAggregate(agg, db, program)
    }
    runStrata(strata, db, recordSet, provenance, program, stats)
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
/**
 * True si l'env passe TOUS les constraints + n'a AUCUN negative match.
 * Reject = rule body insatisfait pour cet env.
 */
function envPassesGuards(
  env: Env,
  constraints: Constraint[],
  negatives: Atom[],
  db: Database,
  program: Program,
): boolean {
  for (const c of constraints) {
    if (!evaluateConstraint(c, env, program)) return false
  }
  for (const neg of negatives) {
    if (matchesAny(neg, env, db)) return false
  }
  return true
}

function buildHeadTuple(rule: Rule, env: Env, program: Program): DatalogValue[] {
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
  return headTuple
}

function recordProofIfWanted(
  rule: Rule,
  headTuple: DatalogValue[],
  bodyTuples: Array<{ rel: string; tuple: Tuple }>,
  recordSet: Set<string>,
  provenance: Map<string, Map<string, ProofRecord>>,
): void {
  if (!recordSet.has(rule.head.rel)) return
  const k = tupleKey(rule.head.rel, headTuple)
  const rec = provenance.get(rule.head.rel)!
  if (rec.has(k)) return
  rec.set(k, {
    ruleIndex: rule.index,
    ruleHead: rule.head.rel,
    bodyTuples,
  })
}

function evaluateRule(
  rule: Rule,
  db: Database,
  recordSet: Set<string>,
  provenance: Map<string, Map<string, ProofRecord>>,
  program: Program,
): number {
  const positives = rule.body.filter((a) => !a.negated)
  const negatives = rule.body.filter((a) => a.negated)
  const constraints = rule.constraints ?? []

  const envs: Array<{ env: Env; bodyTuples: Array<{ rel: string; tuple: Tuple }> }> = []
  joinPositive(positives, 0, new Map(), [], db, envs)

  let derived = 0
  for (const { env, bodyTuples } of envs) {
    if (!envPassesGuards(env, constraints, negatives, db, program)) continue
    const headTuple = buildHeadTuple(rule, env, program)
    const headRel = db.relations.get(rule.head.rel)!
    if (insertTuple(headRel, headTuple)) {
      derived++
      recordProofIfWanted(rule, headTuple, bodyTuples, recordSet, provenance)
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
  // Sentinel object distinct de null pour différencier "fail" (return null)
  // vs "OK pas de nouveau binding" (return UNIFY_OK_NO_EXT).
  let ext: Env | null = null
  for (let i = 0; i < atom.args.length; i++) {
    const t = atom.args[i]
    const v = tuple[i]
    if (t.kind === 'const') {
      if (!valueEq(t.value, v)) return null
    } else if (t.kind === 'var') {
      const next = unifyVar(t.name, v, env, ext)
      if (next === UNIFY_FAIL) return null
      if (next !== UNIFY_OK_NO_EXT) ext = next
    }
    // wildcard: no constraint
  }
  return ext ?? env
}

/** Sentinels pour le retour de unifyVar (distincts de null/Env). */
const UNIFY_FAIL: unique symbol = Symbol('unify-fail')
const UNIFY_OK_NO_EXT: unique symbol = Symbol('unify-ok-no-ext')
type UnifyVarResult = Env | typeof UNIFY_FAIL | typeof UNIFY_OK_NO_EXT

/**
 * Unify une variable de term avec une valeur de tuple. Returns :
 *   - UNIFY_FAIL si conflict (existing binding != v),
 *   - UNIFY_OK_NO_EXT si binding existant compatible (pas de nouveau ext),
 *   - Env (le ext étendu) si nouveau binding ajouté.
 */
function unifyVar(name: string, v: DatalogValue, env: Env, ext: Env | null): UnifyVarResult {
  const existing = env.get(name)
  if (existing !== undefined) {
    return valueEq(existing, v) ? UNIFY_OK_NO_EXT : UNIFY_FAIL
  }
  // Need to extend.
  const target = ext ?? new Map(env)
  // Within the same atom, two same-name vars must agree.
  const seenInExt = target.get(name)
  if (seenInExt !== undefined) {
    return valueEq(seenInExt, v) ? target : UNIFY_FAIL
  }
  target.set(name, v)
  return target
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

/**
 * Resolve a Term to its DatalogValue using the current env.
 * Constants resolve directly. Vars look up env (must be bound — guaranteed
 * by parser range-restriction check).
 */
function resolveTerm(
  term: Constraint['left'],
  env: Env,
  program: Program,
): DatalogValue {
  if (term.kind === 'const') return term.value
  if (term.kind === 'var') {
    const v = env.get(term.name)
    if (v === undefined) {
      throw new DatalogError('eval.unboundConstraintVar',
        `unbound variable '${term.name}' in constraint`,
        term.pos, program.source)
    }
    return v
  }
  throw new DatalogError('eval.constraintWildcard',
    'wildcard in constraint — caught earlier in parser?',
    term.pos, program.source)
}

/**
 * Evaluate a numeric constraint (`X > 5`, `A != B`, etc.) against current env.
 * Both sides are resolved then compared per op. Both sides must be numbers
 * for ordering ops (>, <, >=, <=). `!=` works on any type.
 */
function evaluateConstraint(
  c: Constraint,
  env: Env,
  program: Program,
): boolean {
  const l = resolveTerm(c.left, env, program)
  const r = resolveTerm(c.right, env, program)
  if (c.op === '!=') return l !== r
  if (typeof l !== 'number' || typeof r !== 'number') {
    throw new DatalogError('eval.constraintNonNumber',
      `constraint '${c.op}' requires numeric operands, got ${typeof l} and ${typeof r}`,
      c.pos, program.source)
  }
  if (c.op === '>') return l > r
  if (c.op === '<') return l < r
  if (c.op === '>=') return l >= r
  if (c.op === '<=') return l <= r
  /* istanbul ignore next: covered by parser's whitelist */
  throw new DatalogError('eval.unknownConstraintOp',
    `unknown constraint op '${c.op}'`, c.pos, program.source)
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
