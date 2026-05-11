// ADR-032
/**
 * Cross-package contract test : `codegraph-mcp` ↔ `@liby-tools/datalog`.
 *
 * Vérifie que les exports utilisés en prod par codegraph-mcp restent
 * disponibles. Audit dette architecturale 2026-05-12 §T1.3 — sans ce
 * test, si datalog renomme/supprime un de ces 6 symboles, le MCP tool
 * `datalog_query` casse en runtime sans signal CI.
 *
 * Imports utilisés (cf. `src/tools/datalog-query.ts:19-24`) :
 *   - mergePrograms, loadFacts, evaluate, formatProof, tupleKey
 *     (functions)
 *   - DatalogError (class)
 *   - ProofNode (type — non testable au runtime)
 */

import { describe, it, expect } from 'vitest'

describe('cross-package contract : codegraph-mcp ← @liby-tools/datalog', () => {
  it('imports les 5 fonctions consommées par datalog-query tool', async () => {
    const mod = await import('@liby-tools/datalog')
    expect(typeof mod.mergePrograms).toBe('function')
    expect(typeof mod.loadFacts).toBe('function')
    expect(typeof mod.evaluate).toBe('function')
    expect(typeof mod.formatProof).toBe('function')
    expect(typeof mod.tupleKey).toBe('function')
  })

  it('DatalogError reste une class Error throwable', async () => {
    const { DatalogError } = await import('@liby-tools/datalog')
    expect(typeof DatalogError).toBe('function') // class === function en JS
    const err = new DatalogError('TEST_CODE', 'message smoke')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(DatalogError)
    expect(err.code).toBe('TEST_CODE')
    expect(err.message).toBe('message smoke')
  })

  it('mergePrograms smoke : tableau vide → Program vide', async () => {
    const { mergePrograms } = await import('@liby-tools/datalog')
    const prog = mergePrograms([])
    expect(prog).toBeDefined()
    expect(prog.decls).toBeDefined()
    expect(prog.rules).toBeDefined()
  })

  it('tupleKey smoke : retourne une string déterministe', async () => {
    const { tupleKey } = await import('@liby-tools/datalog')
    const k1 = tupleKey('Rel', ['a', 'b'])
    const k2 = tupleKey('Rel', ['a', 'b'])
    expect(typeof k1).toBe('string')
    expect(k1).toBe(k2)
  })
})
