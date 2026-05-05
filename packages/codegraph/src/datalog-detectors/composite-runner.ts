// ADR-026 phase D.2 — composite runner (statique × dynamique unifié)
/**
 * Évalue des rules `.dl` cross-cut qui joignent les facts statique
 * (codegraph) avec les facts dynamique (runtime-graph). Architecture
 * unifiée — pas de fs read séparé, pas de pipeline statique vs runtime
 * dupliqué : tout passe par les Salsa cells.
 *
 * Inputs :
 *   - Statique : `factsByRelation` produit par le runner Datalog
 *     (voir `evaluateCached` dans `runner.ts`)
 *   - Dynamique : `allRuntimeFactsByRelation` Salsa cell
 *     (voir `incremental/runtime-relations.ts`)
 *
 * Output : `Map<RelationName, Tuple[]>` — outputs des composite rules.
 *
 * Cache : Salsa cell `compositeEvalResult` keyée sur le hash combiné
 * statique+runtime+rules. Warm path zéro-change → instant ; warm path
 * runtime-only-change → re-eval léger (composite rules seules).
 *
 * Usage :
 *   ```ts
 *   import { setRuntimeFacts } from '@liby-tools/codegraph/incremental'
 *   import { runCompositeRules } from '@liby-tools/codegraph/composite'
 *
 *   // Côté runtime-graph après capture :
 *   setRuntimeFacts(snapshot)
 *
 *   // Côté codegraph CLI / watcher :
 *   const violations = runCompositeRules({ rulesDl: COMPOSITE_RULES_DL })
 *   ```
 */

import { createHash } from 'node:crypto'
import { parse, loadFacts, evaluate, type Tuple } from '@liby-tools/datalog'
import { allRuntimeFactsByRelation } from '../incremental/runtime-relations.js'

export interface CompositeRunOptions {
  /** Source des rules `.dl` — concatenated string (decl + rules). */
  rulesDl: string
  /**
   * Facts statique additionnels (au-delà du snapshot codegraph).
   * Ex: passer `factsByRelation` produit par le runner Datalog principal,
   * ou les TSV depuis `.codegraph/facts/*.facts`.
   *
   * Format : Map<RelationName, TSV string>. Les keys doivent matcher les
   * `.input <RelationName>` déclarés dans `rulesDl`.
   */
  staticFactsByRelation: Map<string, string>
  /**
   * Si `true` (default), inclut les facts runtime via la Salsa cell
   * `allRuntimeFactsByRelation`. Mettre à `false` pour skip runtime
   * (ex: tests qui veulent une exécution statique-only).
   */
  includeRuntime?: boolean
}

export interface CompositeRunResult {
  /** Map<output relation name, Tuple[]> — directement utilisable par le caller. */
  outputs: Map<string, Tuple[]>
  stats: {
    /** Total ms wall clock. */
    durationMs: number
    /** Cache hit ? Si oui, durationMs ≈ hash compute time. */
    cacheHit: boolean
    /** Tuples in (statique + runtime). */
    tuplesIn: number
    /** Tuples out (somme des outputs). */
    tuplesOut: number
  }
}

// ─── Cache module-level ────────────────────────────────────────────────

interface CompositeCacheEntry {
  combinedHash: string
  outputs: Map<string, Tuple[]>
  tuplesIn: number
  tuplesOut: number
}

const programCache = new Map<string, ReturnType<typeof parse>>()
let lastEvalCache: CompositeCacheEntry | null = null

function getCachedCompositeProgram(rulesDl: string): ReturnType<typeof parse> {
  // Hash courte du source rulesDl pour clé cache. Évite de keep parsed
  // programs pour des rulesDl différents en mémoire à long terme — au
  // pire on garde 1 ou 2 programmes (le composite courant + le précédent).
  const key = createHash('sha256').update(rulesDl).digest('hex').slice(0, 16)
  let prog = programCache.get(key)
  if (prog === undefined) {
    prog = parse(rulesDl)
    programCache.set(key, prog)
  }
  return prog
}

function hashCombinedFacts(
  staticFacts: Map<string, string>,
  runtimeFacts: Map<string, string> | null,
  rulesDlKey: string,
): string {
  const h = createHash('sha256')
  h.update(rulesDlKey)
  h.update('\x00')
  // Statique : sort keys pour déterminisme
  const staticNames = [...staticFacts.keys()].sort()
  for (const n of staticNames) {
    h.update('S:' + n)
    h.update('\x00')
    h.update(staticFacts.get(n) ?? '')
    h.update('\x00')
  }
  if (runtimeFacts !== null) {
    const runtimeNames = [...runtimeFacts.keys()].sort()
    for (const n of runtimeNames) {
      h.update('R:' + n)
      h.update('\x00')
      h.update(runtimeFacts.get(n) ?? '')
      h.update('\x00')
    }
  }
  return h.digest('hex').slice(0, 16)
}

/**
 * Reset le cache d'éval composite. Tests / debug.
 */
export function _resetCompositeCache(): void {
  lastEvalCache = null
  programCache.clear()
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Évalue les composite rules. Cold path : parse + load facts + evaluate.
 * Warm path : hit cache (cache hit < 5ms).
 */
export function runCompositeRules(opts: CompositeRunOptions): CompositeRunResult {
  const t0 = performance.now()
  const includeRuntime = opts.includeRuntime ?? true
  const runtimeFacts = includeRuntime ? allRuntimeFactsByRelation.get('all') : null
  const rulesDlKey = createHash('sha256').update(opts.rulesDl).digest('hex').slice(0, 16)
  const combinedHash = hashCombinedFacts(opts.staticFactsByRelation, runtimeFacts, rulesDlKey)

  // Cache hit : return immédiat.
  if (lastEvalCache !== null && lastEvalCache.combinedHash === combinedHash) {
    return {
      outputs: lastEvalCache.outputs,
      stats: {
        durationMs: performance.now() - t0,
        cacheHit: true,
        tuplesIn: lastEvalCache.tuplesIn,
        tuplesOut: lastEvalCache.tuplesOut,
      },
    }
  }

  // Cold/miss : merge facts statique + runtime, evaluate.
  const program = getCachedCompositeProgram(opts.rulesDl)
  const merged = new Map<string, string>(opts.staticFactsByRelation)
  if (runtimeFacts !== null) {
    for (const [name, tsv] of runtimeFacts) {
      // Si la même relation est définie côté statique ET runtime
      // (improbable car les schemas sont disjoints), on concatène.
      const existing = merged.get(name)
      if (existing !== undefined && existing.length > 0) {
        merged.set(name, existing + '\n' + tsv)
      } else {
        merged.set(name, tsv)
      }
    }
  }

  // Filter merged pour ne garder que les relations déclarées dans rulesDl.
  // Sinon `loadFacts` throw pour toute fact d'une relation non-`.input`.
  // Pratique : permet au caller de passer des facts en surplus (typique
  // quand on combine un set statique large + un set runtime large mais
  // que la rule `.dl` n'utilise qu'un sous-ensemble).
  const filtered = new Map<string, string>()
  for (const [name, tsv] of merged) {
    if (program.decls.has(name)) filtered.set(name, tsv)
  }
  const db = loadFacts(program.decls, { factsByRelation: filtered })
  const result = evaluate(program, db, {})

  let tuplesIn = 0
  for (const v of merged.values()) {
    if (v.length === 0) continue
    tuplesIn += v.split('\n').length
  }
  let tuplesOut = 0
  for (const tuples of result.outputs.values()) tuplesOut += tuples.length

  lastEvalCache = { combinedHash, outputs: result.outputs, tuplesIn, tuplesOut }
  return {
    outputs: result.outputs,
    stats: {
      durationMs: performance.now() - t0,
      cacheHit: false,
      tuplesIn,
      tuplesOut,
    },
  }
}
