// ADR-024
/**
 * BSP scheduler — orchestrator 4-phase pour parallélisme déterministe.
 *
 * Bulk Synchronous Parallel (Valiant 1990) : alternance compute/barrier/reduce.
 * Chaque phase a la propriété que ses workers sont indépendants — l'ordre
 * d'évaluation n'affecte pas le résultat car la fusion est monoïdale.
 *
 * Architecture :
 *
 *   Phase 1 — Map (parallel) : per-file pure extractors
 *      Chaque fichier f → workerFn(f) → résultats locaux indépendants
 *
 *   Phase 2 — Reduce (parallel tree, future) : monoid combine
 *      Aujourd'hui : foldMonoid linéaire O(N)
 *      Phase β : reduce-tree O(log N) via worker_threads
 *
 *   Phase 3 — Cross-file algos (sequential) : graph algos sur le résultat fusionné
 *      Cycles, articulation, PageRank, NCD — pas dans ce module
 *
 *   Phase 4 — Write (parallel I/O) : Promise.all sur les writes facts
 *
 * Phase 1 actuelle : Promise.all dans le main thread.
 *   - Vrais gains sur les détecteurs I/O-bound (read file)
 *   - Gains limités sur CPU-bound (Node single-threaded JS)
 *   - Architecture prête pour worker_threads (Phase β) sans changer l'API
 *
 * Déterminisme garanti : chaque détecteur doit retourner un Monoid<T>
 * (associatif, idéalement commutatif). Si non-commutatif, fournir sortFn
 * pour ordre canonique. Les tests d'invariant comparent l'output parallel
 * vs sequential — bit-identique.
 */

import type { Monoid } from './monoid.js'
import { foldMonoid } from './monoid.js'

export interface ParallelMapOptions<Item, Result> {
  /** Items à traiter en parallel — typiquement la liste des fichiers. */
  items: Item[]
  /** Worker fn pure : item → résultat local. Doit être déterministe. */
  workerFn: (item: Item) => Promise<Result>
  /** Monoïde pour fusionner les résultats. */
  monoid: Monoid<Result>
  /** Concurrence max simultanée. Default = N items (no limit). */
  concurrency?: number
}

export interface ParallelMapResult<Result> {
  /** Résultat fusionné. Bit-identique entre runs. */
  result: Result
  /** Stats pour observabilité. */
  stats: {
    itemCount: number
    durationMs: number
    /** Chemin critique = max worker ms (proxy du gain max possible). */
    maxWorkerMs: number
    /** Total worker ms = ce qu'on aurait pris en sequential. */
    totalWorkerMs: number
    /** Speedup réel = total / wall (proxy de l'utilisation des cores). */
    speedup: number
  }
}

/**
 * Map + Reduce monoïdal en parallèle.
 *
 * Théorème : si workerFn est pure et monoïde commutatif,
 * `parallelMap(items)` ≡ `foldMonoid(items.map(workerFn))` (séquentiel).
 *
 * Si non-commutatif, le théorème devient "≡ modulo l'ordre déterministe
 * imposé par sortFn". L'output reste bit-identique entre runs.
 */
export async function parallelMap<Item, Result>(
  opts: ParallelMapOptions<Item, Result>,
): Promise<ParallelMapResult<Result>> {
  const t0 = performance.now()
  const concurrency = opts.concurrency ?? opts.items.length
  const workerMs: number[] = []

  const results = await runWithConcurrency(opts.items, opts.workerFn, concurrency, workerMs)
  const fused = foldMonoid(results, opts.monoid)
  const durationMs = performance.now() - t0
  const totalWorkerMs = workerMs.reduce((s, w) => s + w, 0)
  const maxWorkerMs = workerMs.length > 0 ? Math.max(...workerMs) : 0

  return {
    result: fused,
    stats: {
      itemCount: opts.items.length,
      durationMs,
      maxWorkerMs,
      totalWorkerMs,
      speedup: durationMs > 0 ? totalWorkerMs / durationMs : 0,
    },
  }
}

/**
 * Helper : run workerFn sur tous les items avec un cap de concurrency.
 * Pas de Promise.all naïf qui spawn N items en simultané (peut overload
 * fs handles, AST parser, etc.). Round-robin via un pool simple.
 */
async function runWithConcurrency<Item, Result>(
  items: Item[],
  workerFn: (item: Item) => Promise<Result>,
  concurrency: number,
  workerMs: number[],
): Promise<Result[]> {
  if (items.length === 0) return []
  if (concurrency >= items.length) {
    return Promise.all(items.map((item) => timed(workerFn, item, workerMs)))
  }

  const results: Result[] = new Array(items.length)
  let nextIdx = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const i = nextIdx++
      if (i >= items.length) return
      results[i] = await timed(workerFn, items[i], workerMs)
    }
  }
  const workers = Array.from({ length: concurrency }, () => worker())
  await Promise.all(workers)
  return results
}

async function timed<Item, Result>(
  fn: (item: Item) => Promise<Result>,
  item: Item,
  workerMs: number[],
): Promise<Result> {
  const t = performance.now()
  const r = await fn(item)
  workerMs.push(performance.now() - t)
  return r
}
