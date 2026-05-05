// ADR-026 phase D — push runtime snapshot dans les Salsa cells codegraph
/**
 * Pendant ou après chaque capture (synthetic / replay-tests / chaos),
 * pousse le `RuntimeSnapshot` aggrégé vers `@liby-tools/codegraph`. Les
 * cells Salsa de codegraph bumpent leur revision ; toutes les composite
 * rules statique × dynamique cachées (cf. `runCompositeRules`) sont
 * invalidées sélectivement et re-évaluées au prochain check.
 *
 * Soft-dep : @liby-tools/codegraph est peer optional. Si non installé,
 * `pushFactsToSalsa` log un warn et no-op — le pipeline continue avec
 * juste le disk export (`exportFactsRuntime`).
 *
 * Usage typique (CLI / programmatic) :
 *   ```ts
 *   const snapshot = aggregateSpans(spans, runMeta)
 *   await exportFactsRuntime(snapshot, { outDir })  // disk
 *   await pushFactsToSalsa(snapshot)                 // salsa cells
 *   ```
 */

import type { RuntimeSnapshot } from '../core/types.js'

let warnedMissing = false

/**
 * Push le snapshot vers les Salsa cells de @liby-tools/codegraph.
 * Returns true si le push a réussi, false si codegraph absent ou erreur.
 *
 * Idempotent : Salsa input cells dédupent sur égalité, donc ré-appel
 * avec le même snapshot ne bumpe pas les revisions.
 */
export async function pushFactsToSalsa(snapshot: RuntimeSnapshot): Promise<boolean> {
  let mod: typeof import('@liby-tools/codegraph') | null = null
  try {
    mod = await import('@liby-tools/codegraph')
  } catch {
    if (!warnedMissing) {
      console.warn(
        '[runtime-graph] @liby-tools/codegraph non installé — pushFactsToSalsa skip. ' +
        'Install codegraph pour activer le warm path composite statique × dynamique.',
      )
      warnedMissing = true
    }
    return false
  }
  if (typeof mod.setRuntimeFacts !== 'function') {
    if (!warnedMissing) {
      console.warn(
        '[runtime-graph] @liby-tools/codegraph version trop ancienne (manque ' +
        'setRuntimeFacts). Upgrade vers >=0.4.0 pour le composite Salsa.',
      )
      warnedMissing = true
    }
    return false
  }
  try {
    mod.setRuntimeFacts({
      symbolsTouched: snapshot.symbolsTouched,
      httpRouteHits: snapshot.httpRouteHits,
      dbQueriesExecuted: snapshot.dbQueriesExecuted,
      redisOps: snapshot.redisOps,
      eventsEmitted: snapshot.eventsEmitted,
      callEdges: snapshot.callEdges,
      latencySeries: snapshot.latencySeries,
      meta: snapshot.meta,
    })
    return true
  } catch (err) {
    console.error(`[runtime-graph] pushFactsToSalsa failed: ${err}`)
    return false
  }
}

/**
 * Reset les cells côté codegraph (snapshot vide). Utile en CLI cold
 * start ou tests d'isolation. No-op si codegraph absent.
 */
export async function clearFactsInSalsa(): Promise<boolean> {
  try {
    const mod = await import('@liby-tools/codegraph')
    if (typeof mod.clearRuntimeFacts === 'function') {
      mod.clearRuntimeFacts()
      return true
    }
  } catch {
    // codegraph absent — silent
  }
  return false
}
