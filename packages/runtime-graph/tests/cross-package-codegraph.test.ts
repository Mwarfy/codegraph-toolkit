// ADR-032
/**
 * Cross-package contract test : `runtime-graph` ↔ `@liby-tools/codegraph`.
 *
 * runtime-graph push ses snapshots aggrégés vers les cells Salsa de
 * codegraph via `setRuntimeFacts` (composite statique × dynamique). Soft
 * dep — peer optional. Si codegraph absent OU si l'API change sans bump
 * coordonné, le push fait silent no-op en prod (cf.
 * `src/facts/salsa-push.ts:32-72`).
 *
 * Audit dette architecturale 2026-05-12 §T1.4 (direction B) — sans ce
 * test, codegraph peut retirer `setRuntimeFacts` du public API et
 * runtime-graph perd silencieusement le warm path composite.
 *
 * Symboles consommés dynamiquement :
 *   - `mod.setRuntimeFacts(snapshot)` (function, salsa-push.ts:57)
 *   - `mod.clearRuntimeFacts()` (function, salsa-push.ts:82)
 */

import { describe, it, expect } from 'vitest'

describe('cross-package contract : runtime-graph ← @liby-tools/codegraph', () => {
  it('setRuntimeFacts + clearRuntimeFacts restent exposés au top-level', async () => {
    const mod = await import('@liby-tools/codegraph')
    expect(typeof mod.setRuntimeFacts).toBe('function')
    expect(typeof mod.clearRuntimeFacts).toBe('function')
  })

  it('clearRuntimeFacts smoke : appel sans args est safe (no-op)', async () => {
    const { clearRuntimeFacts } = await import('@liby-tools/codegraph')
    expect(() => clearRuntimeFacts()).not.toThrow()
  })

  it('setRuntimeFacts accepte un RuntimeFactsSnapshot minimal', async () => {
    const { setRuntimeFacts, clearRuntimeFacts } = await import('@liby-tools/codegraph')
    expect(() =>
      setRuntimeFacts({
        symbolsTouched: [],
        httpRouteHits: [],
        dbQueriesExecuted: [],
        redisOps: [],
        eventsEmitted: [],
        callEdges: [],
        meta: {
          driver: 'test',
          startedAtUnix: 0,
          durationMs: 0,
          totalSpans: 0,
        },
      }),
    ).not.toThrow()
    // Cleanup pour ne pas leak dans d'autres tests.
    clearRuntimeFacts()
  })
})
