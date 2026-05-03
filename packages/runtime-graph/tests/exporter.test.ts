/**
 * TSV exporter tests — vérifie que le format de sortie est correct
 * (TSV strict, sorted, datalog-loadable).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { exportFactsRuntime } from '../src/facts/exporter.js'
import type { RuntimeSnapshot } from '../src/core/types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rg-export-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const emptySnapshot: RuntimeSnapshot = {
  symbolsTouched: [],
  httpRouteHits: [],
  dbQueriesExecuted: [],
  redisOps: [],
  eventsEmitted: [],
  callEdges: [],
  meta: { driver: 'test', startedAtUnix: 1700000000, durationMs: 100, totalSpans: 0 },
}

describe('exportFactsRuntime', () => {
  it('writes 7 fact files + schema + manifest', async () => {
    await exportFactsRuntime(emptySnapshot, { outDir: tmpDir })
    const files = await fs.readdir(tmpDir)
    const factsFiles = files.filter(f => f.endsWith('.facts'))
    expect(factsFiles).toHaveLength(7)
    expect(files).toContain('schema-runtime-graph.dl')
    expect(files).toContain('manifest.json')
  })

  it('writes empty .facts file (zero bytes) when no rows', async () => {
    await exportFactsRuntime(emptySnapshot, { outDir: tmpDir })
    const content = await fs.readFile(path.join(tmpDir, 'SymbolTouchedRuntime.facts'), 'utf-8')
    expect(content).toBe('')
  })

  it('writes TSV with TAB separators (no quotes)', async () => {
    const snap: RuntimeSnapshot = {
      ...emptySnapshot,
      symbolsTouched: [
        { file: 'src/foo.ts', fn: 'doFoo', count: 5, p95LatencyMs: 12 },
      ],
    }
    await exportFactsRuntime(snap, { outDir: tmpDir })
    const content = await fs.readFile(path.join(tmpDir, 'SymbolTouchedRuntime.facts'), 'utf-8')
    expect(content).toBe('src/foo.ts\tdoFoo\t5\t12\n')
  })

  it('sorts rows lex for deterministic output', async () => {
    const snap: RuntimeSnapshot = {
      ...emptySnapshot,
      eventsEmitted: [
        { type: 'b.second', count: 1, lastAtUnix: 100 },
        { type: 'a.first', count: 2, lastAtUnix: 200 },
        { type: 'c.third', count: 3, lastAtUnix: 300 },
      ],
    }
    await exportFactsRuntime(snap, { outDir: tmpDir })
    const content = await fs.readFile(path.join(tmpDir, 'EventEmittedAtRuntime.facts'), 'utf-8')
    expect(content).toBe('a.first\t2\t200\nb.second\t1\t100\nc.third\t3\t300\n')
  })

  it('schema-runtime-graph.dl declares all 7 input relations + RuntimeAlert output', async () => {
    await exportFactsRuntime(emptySnapshot, { outDir: tmpDir })
    const schema = await fs.readFile(path.join(tmpDir, 'schema-runtime-graph.dl'), 'utf-8')
    expect(schema).toContain('.decl SymbolTouchedRuntime')
    expect(schema).toContain('.input SymbolTouchedRuntime')
    expect(schema).toContain('.decl HttpRouteHit')
    expect(schema).toContain('.decl DbQueryExecuted')
    expect(schema).toContain('.decl RedisOpExecuted')
    expect(schema).toContain('.decl EventEmittedAtRuntime')
    expect(schema).toContain('.decl CallEdgeRuntime')
    expect(schema).toContain('.decl RuntimeRunMeta')
    expect(schema).toContain('.decl RuntimeAlert')
    expect(schema).toContain('.output RuntimeAlert')
  })

  it('manifest.json carries run meta + relation tuple counts', async () => {
    const snap: RuntimeSnapshot = {
      ...emptySnapshot,
      symbolsTouched: [{ file: 'src/x.ts', fn: 'fn', count: 1, p95LatencyMs: 0 }],
      meta: { driver: 'synthetic', startedAtUnix: 1700000000, durationMs: 5000, totalSpans: 42 },
    }
    await exportFactsRuntime(snap, { outDir: tmpDir })
    const manifest = JSON.parse(await fs.readFile(path.join(tmpDir, 'manifest.json'), 'utf-8'))
    expect(manifest.driver).toBe('synthetic')
    expect(manifest.totalSpans).toBe(42)
    expect(manifest.relations.find((r: { name: string }) => r.name === 'SymbolTouchedRuntime').tuples).toBe(1)
  })

  it('strips tabs/newlines from string columns (TSV safety)', async () => {
    const snap: RuntimeSnapshot = {
      ...emptySnapshot,
      symbolsTouched: [
        { file: 'src/foo\tbar.ts', fn: 'has\nnewline', count: 1, p95LatencyMs: 0 },
      ],
    }
    await exportFactsRuntime(snap, { outDir: tmpDir })
    const content = await fs.readFile(path.join(tmpDir, 'SymbolTouchedRuntime.facts'), 'utf-8')
    // Tab and newline replaced by space, kept on one line
    expect(content).toBe('src/foo bar.ts\thas newline\t1\t0\n')
  })

  it('truncates non-integer numbers safely', async () => {
    const snap: RuntimeSnapshot = {
      ...emptySnapshot,
      symbolsTouched: [
        { file: 'src/x.ts', fn: 'fn', count: 5, p95LatencyMs: 12.7 },
      ],
    }
    await exportFactsRuntime(snap, { outDir: tmpDir })
    const content = await fs.readFile(path.join(tmpDir, 'SymbolTouchedRuntime.facts'), 'utf-8')
    expect(content).toBe('src/x.ts\tfn\t5\t12\n')                        // .7 truncated
  })
})
