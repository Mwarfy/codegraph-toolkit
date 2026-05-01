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
  type Atom, type Constraint,
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

export function evaluate(
  program: Program,
  db: Database,
  options: EvalOptions = {},
): RunResult {
  const t0 = performance.now()
  const recordSet = new Set(options.recordProofsFor ?? [])

  // Add inline facts (parsed from `.dl` source) into the DB.
  // Acceptés sur n'importe quelle relation déclarée — utile pour les
  // lookup tables (`.decl ForbiddenCoercion` + facts inline) et pour
  // pré-remplir une relation aussi écrite par des rules.
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

  const runStrata = (): void => {
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

  runStrata()

  // ─── Aggregates (Tier 14 alt2) ───
  // Post-strates : count/sum/min/max sur les relations matérialisées.
  // Les relations résultats ne sont PAS marquées .output par défaut —
  // l'utilisateur peut ajouter `.output X` dans son source pour les
  // exposer, ou les utiliser comme input de rules ultérieures.
  if (program.aggregates && program.aggregates.length > 0) {
    for (const agg of program.aggregates) {
      const sourceRel = db.relations.get(agg.sourceRel)
      if (!sourceRel) {
        throw new DatalogError('eval.aggregateUnknownSource',
          `aggregate '${agg.resultRel}' references unknown source '${agg.sourceRel}'`,
          agg.pos, program.source)
      }
      // Déterminer les indices "clés" (positions de variables dans pattern)
      // et les renvoyer dans l'ordre d'apparition (= ordre des cols résultat,
      // sauf la dernière col qui est la valeur agrégée).
      const groupCols: number[] = []
      for (let i = 0; i < agg.pattern.length; i++) {
        if (agg.pattern[i].kind === 'var') groupCols.push(i)
      }

      // Pour sum/min/max : on a besoin de désigner LA colonne valeur du
      // source. Convention : c'est la dernière variable dans pattern qui
      // mappe à la dernière col du résultat (l'agrégat). On extrait avant
      // l'arity check pour que celui-ci voie les "vraies" group cols.
      let valueColIdx = -1
      if (agg.kind !== 'count') {
        if (groupCols.length === 0) {
          throw new DatalogError('eval.aggregateNoValueCol',
            `'${agg.kind}' aggregate '${agg.resultRel}' needs at least one value variable in source pattern`,
            agg.pos, program.source)
        }
        valueColIdx = groupCols[groupCols.length - 1]
        // La last group var devient la value col → on l'enlève des group keys.
        groupCols.pop()
      }

      // resultDecl arity = groupCols.length + 1 (l'agrégat).
      if (groupCols.length !== agg.resultDecl.columns.length - 1) {
        throw new DatalogError('eval.aggregateArityMismatch',
          `aggregate '${agg.resultRel}': ${groupCols.length} group var(s) but result has ${agg.resultDecl.columns.length - 1} non-aggregate col(s)`,
          agg.pos, program.source)
      }

      // Map<canonicalGroupKey, { groupKey: tuple, accum: number }>
      const buckets = new Map<string, { keyTuple: DatalogValue[]; accum: number }>()
      for (const row of sourceRel.tuples) {
        // Match constants in pattern (non-var, non-wildcard) — skip si mismatch.
        let matches = true
        for (let i = 0; i < agg.pattern.length; i++) {
          const term = agg.pattern[i]
          if (term.kind === 'const' && row[i] !== term.value) { matches = false; break }
        }
        if (!matches) continue

        const keyTuple = groupCols.map((i) => row[i])
        const key = keyTuple.map((v) => String(v)).join('\x00')
        let bucket = buckets.get(key)
        if (!bucket) {
          const initAccum = agg.kind === 'count' ? 0
            : agg.kind === 'sum' ? 0
            : agg.kind === 'min' ? Number.POSITIVE_INFINITY
            : Number.NEGATIVE_INFINITY                                // max
          bucket = { keyTuple: keyTuple.slice(), accum: initAccum }
          buckets.set(key, bucket)
        }
        if (agg.kind === 'count') bucket.accum += 1
        else {
          const v = row[valueColIdx]
          if (typeof v !== 'number') {
            throw new DatalogError('eval.aggregateNonNumber',
              `'${agg.kind}' aggregate '${agg.resultRel}': value column '${agg.pattern[valueColIdx].kind === 'var' ? (agg.pattern[valueColIdx] as { name: string }).name : '?'}' must be number, got ${typeof v} '${v}'`,
              agg.pos, program.source)
          }
          if (agg.kind === 'sum') bucket.accum += v
          else if (agg.kind === 'min') bucket.accum = Math.min(bucket.accum, v)
          else if (agg.kind === 'max') bucket.accum = Math.max(bucket.accum, v)
        }
      }

      // Insérer les résultats dans la DB. La relation résultat doit déjà
      // exister via initRelations (créée à partir de decls.set en parsing).
      const resultRel = db.relations.get(agg.resultRel)
      if (!resultRel) {
        throw new DatalogError('eval.aggregateMissingResultRel',
          `aggregate result relation '${agg.resultRel}' not initialized in DB — bug?`,
          agg.pos, program.source)
      }
      for (const bucket of buckets.values()) {
        const tuple: DatalogValue[] = [...bucket.keyTuple, bucket.accum]
        insertTuple(resultRel, tuple)
      }
    }
    // Tier 15 : after aggregates, re-run strata so rules consuming aggregate
    // results (typical god-X / threshold patterns) can derive their heads.
    // Idempotent thanks to insertTuple dedup — already-derived tuples are
    // no-ops on re-evaluation.
    runStrata()
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

  const constraints = rule.constraints ?? []

  let derived = 0
  for (const { env, bodyTuples } of envs) {
    // Constraints (Tier 15) : numeric post-filter on bound variables.
    let rejected = false
    for (const c of constraints) {
      if (!evaluateConstraint(c, env, program)) { rejected = true; break }
    }
    if (rejected) continue
    // Negatives : reject if any matches.
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
