// ADR-026 phase D.1+D.2 — tests du pipeline composite statique × dynamique.
/**
 * Vérifie :
 *   1. Les Salsa cells `runtime*` se peuplent via `setRuntimeFacts` et
 *      sont accessibles via la cell `derived` `allRuntimeFactsByRelation`.
 *   2. `runCompositeRules` évalue une rule cross-cut (DEAD_HANDLER) sur
 *      facts statique mock + facts runtime poussés via setter.
 *   3. Cache : 2 runs successifs sans changement → cache hit.
 *   4. Invalidation : push d'un nouveau snapshot runtime → cache miss,
 *      re-eval.
 *   5. Composite rule détecte correctement DEAD_HANDLER (export statique
 *      sans symbol touched runtime).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  setRuntimeFacts, clearRuntimeFacts, allRuntimeFactsByRelation,
  runtimeSymbolsTouched,
} from '../src/incremental/runtime-relations.js'
import { runCompositeRules, _resetCompositeCache } from '../src/datalog-detectors/composite-runner.js'
import { sharedDb } from '../src/incremental/database.js'

const MOCK_SNAPSHOT = {
  symbolsTouched: [
    { file: 'src/a.ts', fn: 'usedFn', count: 10, p95LatencyMs: 50 },
  ],
  httpRouteHits: [
    { method: 'GET', path: '/api/orders', status: 200, count: 100, p95LatencyMs: 30 },
  ],
  dbQueriesExecuted: [
    { table: 'orders', op: 'SELECT', count: 50, lastAtUnix: 1700000000 },
  ],
  redisOps: [],
  eventsEmitted: [],
  callEdges: [],
  meta: { driver: 'synthetic', startedAtUnix: 1700000000, durationMs: 1000, totalSpans: 100 },
}

describe('Phase D.1 — runtime-relations Salsa cells', () => {
  beforeEach(() => {
    sharedDb.reset()
    _resetCompositeCache()
  })

  it('setRuntimeFacts populates cells and aggregator produces TSV', () => {
    setRuntimeFacts(MOCK_SNAPSHOT)
    expect(runtimeSymbolsTouched.get('all')).toHaveLength(1)

    const factsByRelation = allRuntimeFactsByRelation.get('all')
    expect(factsByRelation.get('SymbolTouchedRuntime')).toContain('src/a.ts\tusedFn\t10\t50')
    expect(factsByRelation.get('HttpRouteHit')).toContain('GET\t/api/orders\t200\t100\t30')
    expect(factsByRelation.get('DbQueryExecuted')).toContain('orders\tSELECT\t50\t1700000000')
  })

  it('clearRuntimeFacts empties all cells', () => {
    setRuntimeFacts(MOCK_SNAPSHOT)
    clearRuntimeFacts()
    expect(runtimeSymbolsTouched.get('all')).toHaveLength(0)
    const factsByRelation = allRuntimeFactsByRelation.get('all')
    expect(factsByRelation.get('SymbolTouchedRuntime')).toBe('')
  })

  it('aggregator cell invalidates when input changes', () => {
    setRuntimeFacts(MOCK_SNAPSHOT)
    const facts1 = allRuntimeFactsByRelation.get('all')
    const before = facts1.get('SymbolTouchedRuntime')

    // Push new snapshot with extra symbol
    setRuntimeFacts({
      ...MOCK_SNAPSHOT,
      symbolsTouched: [
        ...MOCK_SNAPSHOT.symbolsTouched,
        { file: 'src/b.ts', fn: 'newFn', count: 5, p95LatencyMs: 100 },
      ],
    })
    const facts2 = allRuntimeFactsByRelation.get('all')
    const after = facts2.get('SymbolTouchedRuntime')
    expect(after).not.toBe(before)
    expect(after).toContain('src/b.ts\tnewFn\t5\t100')
  })
})

describe('Phase D.2 — composite cross-cut runner', () => {
  beforeEach(() => {
    sharedDb.reset()
    _resetCompositeCache()
  })

  it('evaluates DEAD_HANDLER rule joining static export + runtime touch', () => {
    setRuntimeFacts(MOCK_SNAPSHOT)
    const staticFacts = new Map<string, string>([
      ['ExportedFunction', [
        'src/a.ts\tusedFn',     // touched runtime
        'src/a.ts\tdeadFn',     // NOT touched
        'src/c.ts\torphanFn',   // NOT touched
      ].join('\n')],
    ])
    const rulesDl = `
.decl ExportedFunction(file: symbol, fn: symbol)
.input ExportedFunction
.decl SymbolTouchedRuntime(file: symbol, fn: symbol, count: number, p95: number)
.input SymbolTouchedRuntime
.decl DeadHandler(file: symbol, fn: symbol)
.output DeadHandler
DeadHandler(F, Fn) :- ExportedFunction(F, Fn), !SymbolTouchedRuntime(F, Fn, _, _).
`
    const result = runCompositeRules({ rulesDl, staticFactsByRelation: staticFacts })
    const deadHandlers = result.outputs.get('DeadHandler') ?? []
    expect(deadHandlers).toHaveLength(2)
    const dhKeys = new Set(deadHandlers.map((t) => `${t[0]}|${t[1]}`))
    expect(dhKeys.has('src/a.ts|deadFn')).toBe(true)
    expect(dhKeys.has('src/c.ts|orphanFn')).toBe(true)
    expect(dhKeys.has('src/a.ts|usedFn')).toBe(false)  // touched, exclu
  })

  it('cache hits on identical re-run', () => {
    setRuntimeFacts(MOCK_SNAPSHOT)
    const staticFacts = new Map<string, string>([
      ['ExportedFunction', 'src/a.ts\tusedFn\nsrc/a.ts\tdeadFn'],
    ])
    const rulesDl = `
.decl ExportedFunction(file: symbol, fn: symbol)
.input ExportedFunction
.decl SymbolTouchedRuntime(file: symbol, fn: symbol, count: number, p95: number)
.input SymbolTouchedRuntime
.decl DeadHandler(file: symbol, fn: symbol)
.output DeadHandler
DeadHandler(F, Fn) :- ExportedFunction(F, Fn), !SymbolTouchedRuntime(F, Fn, _, _).
`
    const r1 = runCompositeRules({ rulesDl, staticFactsByRelation: staticFacts })
    const r2 = runCompositeRules({ rulesDl, staticFactsByRelation: staticFacts })

    expect(r1.stats.cacheHit).toBe(false)
    expect(r2.stats.cacheHit).toBe(true)
    // Outputs identiques
    expect(r2.outputs.get('DeadHandler')?.length).toBe(r1.outputs.get('DeadHandler')?.length)
  })

  it('invalidates cache when runtime facts change', () => {
    setRuntimeFacts(MOCK_SNAPSHOT)
    const staticFacts = new Map<string, string>([
      ['ExportedFunction', 'src/a.ts\tusedFn\nsrc/a.ts\tdeadFn'],
    ])
    const rulesDl = `
.decl ExportedFunction(file: symbol, fn: symbol)
.input ExportedFunction
.decl SymbolTouchedRuntime(file: symbol, fn: symbol, count: number, p95: number)
.input SymbolTouchedRuntime
.decl DeadHandler(file: symbol, fn: symbol)
.output DeadHandler
DeadHandler(F, Fn) :- ExportedFunction(F, Fn), !SymbolTouchedRuntime(F, Fn, _, _).
`
    const r1 = runCompositeRules({ rulesDl, staticFactsByRelation: staticFacts })
    expect(r1.outputs.get('DeadHandler')).toHaveLength(1)  // deadFn

    // Marquer deadFn comme touché → DEAD_HANDLER doit ne plus le détecter
    setRuntimeFacts({
      ...MOCK_SNAPSHOT,
      symbolsTouched: [
        ...MOCK_SNAPSHOT.symbolsTouched,
        { file: 'src/a.ts', fn: 'deadFn', count: 1, p95LatencyMs: 10 },
      ],
    })
    const r2 = runCompositeRules({ rulesDl, staticFactsByRelation: staticFacts })

    expect(r2.stats.cacheHit).toBe(false)
    expect(r2.outputs.get('DeadHandler') ?? []).toHaveLength(0)
  })
})
