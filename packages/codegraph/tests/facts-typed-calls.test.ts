/**
 * Tests pour l'émission Datalog des relations typed-calls + entry-points
 * (Phase 4 axe 2). Sépare des assertions legacy `facts.test.ts` pour rester
 * dans le format vitest.
 *
 * Cible :
 *   - SymbolCallEdge  : edges typés ("file:sym" → "file:sym", line)
 *   - SymbolSignature : signatures (file, name, kind, line)
 *   - EntryPoint      : sources flow (file, kind, id) — dédup cross-flows
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { exportFacts } from '../src/facts/index.js'
import type { GraphSnapshot } from '../src/core/types.js'

let tmp: string

function makeSnapshot(): GraphSnapshot {
  return {
    version: '1',
    generatedAt: '2026-04-30T20:00:00.000Z',
    commitHash: 'cafebab',
    rootDir: '/tmp/fake',
    nodes: [],
    edges: [],
    stats: {
      totalFiles: 0, totalEdges: 0,
      orphanCount: 0, connectedCount: 0,
      entryPointCount: 0, uncertainCount: 0,
      edgesByType: {
        import: 0, event: 0, route: 0, queue: 0, 'dynamic-load': 0, 'db-table': 0,
      },
      healthScore: 1,
    },
    typedCalls: {
      signatures: [
        {
          file: 'src/handler.ts',
          exportName: 'handleRoute',
          kind: 'function',
          params: [{ name: 'req', type: 'Request', optional: false }],
          returnType: 'Promise<Response>',
          line: 10,
        },
        {
          file: 'src/db.ts',
          exportName: 'query',
          kind: 'function',
          params: [{ name: 'sql', type: 'string', optional: false }],
          returnType: 'Promise<Row[]>',
          line: 5,
        },
        {
          file: 'src/zod.ts',
          exportName: 'validate',
          kind: 'function',
          params: [],
          returnType: 'unknown',
          line: 1,
        },
      ],
      callEdges: [
        {
          from: 'src/handler.ts:handleRoute',
          to: 'src/zod.ts:validate',
          argTypes: ['Request'],
          returnType: 'unknown',
          line: 12,
        },
        {
          from: 'src/handler.ts:handleRoute',
          to: 'src/db.ts:query',
          argTypes: ['string'],
          returnType: 'Promise<Row[]>',
          line: 15,
        },
        // Edge dégénéré : pas de `:` dans `to` → doit être skippé proprement.
        {
          from: 'src/handler.ts:handleRoute',
          to: 'malformed-no-colon',
          argTypes: [],
          returnType: 'void',
          line: 20,
        },
      ],
    },
    dataFlows: [
      {
        entry: {
          kind: 'http-route',
          id: 'POST /api/foo',
          file: 'src/handler.ts',
          line: 10,
          handler: 'src/handler.ts:handleRoute',
        },
        steps: [],
        sinks: [],
      },
      {
        entry: {
          kind: 'event-listener',
          id: 'event:user.created',
          file: 'src/listener.ts',
          line: 5,
        },
        steps: [],
        sinks: [],
        // Downstream chain — son entry doit aussi apparaître.
        downstream: [
          {
            entry: {
              kind: 'event-listener',
              id: 'event:user.persisted',
              file: 'src/listener.ts',
              line: 25,
            },
            steps: [],
            sinks: [],
          },
        ],
      },
      // Duplicate du premier — testes la dédup (file, kind, id).
      {
        entry: {
          kind: 'http-route',
          id: 'POST /api/foo',
          file: 'src/handler.ts',
          line: 10,
        },
        steps: [],
        sinks: [],
      },
    ],
  } as unknown as GraphSnapshot
}

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-facts-typed-calls-'))
  await exportFacts(makeSnapshot(), { outDir: tmp })
})

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

async function readTuples(name: string): Promise<string[][]> {
  const content = await fs.readFile(path.join(tmp, `${name}.facts`), 'utf-8')
  return content.split('\n').filter((l) => l.length > 0).map((l) => l.split('\t'))
}

describe('facts emitter — Phase 4 axe 2 (typed calls + entry points)', () => {
  it('SymbolSignature émet une ligne par signature', async () => {
    const tuples = await readTuples('SymbolSignature')
    expect(tuples).toHaveLength(3)
    const sorted = [...tuples].sort()
    expect(sorted).toEqual([
      ['src/db.ts', 'query', 'function', '5'],
      ['src/handler.ts', 'handleRoute', 'function', '10'],
      ['src/zod.ts', 'validate', 'function', '1'],
    ])
  })

  it('SymbolCallEdge split file/symbol et skip les edges dégradés', async () => {
    const tuples = await readTuples('SymbolCallEdge')
    // L'edge "malformed-no-colon" doit être skippé → 2 edges valides.
    expect(tuples).toHaveLength(2)
    const sorted = [...tuples].sort()
    expect(sorted).toEqual([
      ['src/handler.ts', 'handleRoute', 'src/db.ts', 'query', '15'],
      ['src/handler.ts', 'handleRoute', 'src/zod.ts', 'validate', '12'],
    ])
  })

  it('EntryPoint dédup (file, kind, id) et capture les downstream', async () => {
    const tuples = await readTuples('EntryPoint')
    // 3 entries distincts attendus :
    //   - http-route POST /api/foo (le doublon est dédup)
    //   - event-listener event:user.created
    //   - event-listener event:user.persisted (depuis downstream)
    expect(tuples).toHaveLength(3)
    const sorted = [...tuples].sort()
    expect(sorted).toEqual([
      ['src/handler.ts', 'http-route', 'POST /api/foo'],
      ['src/listener.ts', 'event-listener', 'event:user.created'],
      ['src/listener.ts', 'event-listener', 'event:user.persisted'],
    ])
  })

  it('schema.dl déclare les 3 nouvelles relations en .input', async () => {
    const schema = await fs.readFile(path.join(tmp, 'schema.dl'), 'utf-8')
    for (const name of ['SymbolCallEdge', 'SymbolSignature', 'EntryPoint']) {
      expect(schema).toContain(`.decl ${name}(`)
      expect(schema).toContain(`.input ${name}`)
    }
  })

  it('snapshot sans typedCalls : émet les fichiers vides (pas de crash)', async () => {
    const tmp2 = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-facts-typed-empty-'))
    try {
      const snap = makeSnapshot()
      delete (snap as any).typedCalls
      delete (snap as any).dataFlows
      await exportFacts(snap, { outDir: tmp2 })
      const callEdges = await fs.readFile(path.join(tmp2, 'SymbolCallEdge.facts'), 'utf-8')
      const sigs = await fs.readFile(path.join(tmp2, 'SymbolSignature.facts'), 'utf-8')
      const entries = await fs.readFile(path.join(tmp2, 'EntryPoint.facts'), 'utf-8')
      expect(callEdges).toBe('')
      expect(sigs).toBe('')
      expect(entries).toBe('')
    } finally {
      await fs.rm(tmp2, { recursive: true, force: true })
    }
  })
})
