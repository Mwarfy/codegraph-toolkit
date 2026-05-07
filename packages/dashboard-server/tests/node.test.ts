import { describe, it, expect } from 'vitest'
import {
  extractEdges,
  extractLongFunctions,
  extractTodos,
  extractEnvVars,
  extractDriftSignals,
  extractCoChange,
  nodeFromSnap,
} from '../src/routes/node.js'

const SNAP = {
  nodes: [
    { id: 'a.ts', type: 'file', status: 'connected' },
    { id: 'b.ts', type: 'file' },
  ],
  edges: [
    { from: 'b.ts', to: 'a.ts', type: 'import' },
    { from: 'c.ts', to: 'a.ts', type: 'import' },
    { from: 'a.ts', to: 'd.ts', type: 'import' },
  ],
  longFunctions: [
    { file: 'a.ts', name: 'big', lines: 120 },
    { file: 'a.ts', lines: 90 }, // no name
    { file: 'b.ts', name: 'huge', lines: 200 },
  ],
  todos: [
    { file: 'a.ts', line: 10, text: 'fix this' },
    { file: 'b.ts', line: 5, text: 'unrelated' },
  ],
  envUsage: [
    { file: 'a.ts', var: 'API_KEY' },
    { file: 'a.ts', var: 'API_KEY' }, // dedup
    { file: 'a.ts', var: 'DB_URL' },
  ],
  driftSignals: [
    { file: 'a.ts', kind: 'deep-nesting', detail: 'depth 6' },
    { file: 'a.ts', detail: 'no kind' }, // defaults
  ],
  coChangePairs: [
    { a: 'a.ts', b: 'partner1.ts', coChangeRate: 0.8, sharedCommits: 12 },
    { a: 'partner2.ts', b: 'a.ts', coChangeRate: 0.5, sharedCommits: 5 },
    { a: 'unrelated1.ts', b: 'unrelated2.ts', coChangeRate: 0.9, sharedCommits: 20 },
  ],
}

describe('extractEdges', () => {
  it('partitions edges by direction relative to the focused id', () => {
    const r = extractEdges(SNAP, 'a.ts')
    expect(r.importers.map((i) => i.from).sort()).toEqual(['b.ts', 'c.ts'])
    expect(r.imports.map((i) => i.to)).toEqual(['d.ts'])
  })

  it('handles isolated node', () => {
    const r = extractEdges(SNAP, 'isolated.ts')
    expect(r.importers).toEqual([])
    expect(r.imports).toEqual([])
  })
})

describe('extractLongFunctions', () => {
  it('returns long fns scoped to the file with <anon> fallback', () => {
    const r = extractLongFunctions(SNAP, 'a.ts')
    expect(r).toEqual([
      { name: 'big', lines: 120 },
      { name: '<anon>', lines: 90 },
    ])
  })
})

describe('extractTodos', () => {
  it('scopes todos to the file', () => {
    const r = extractTodos(SNAP, 'a.ts')
    expect(r).toEqual([{ line: 10, text: 'fix this' }])
  })
})

describe('extractEnvVars', () => {
  it('dedupes env vars per file', () => {
    expect(extractEnvVars(SNAP, 'a.ts').sort()).toEqual(['API_KEY', 'DB_URL'])
  })
})

describe('extractDriftSignals', () => {
  it('defaults missing kind to "drift"', () => {
    const r = extractDriftSignals(SNAP, 'a.ts')
    expect(r).toEqual([
      { kind: 'deep-nesting', detail: 'depth 6' },
      { kind: 'drift', detail: 'no kind' },
    ])
  })
})

describe('extractCoChange', () => {
  it('finds pairs from either side, sorted by rate desc', () => {
    const r = extractCoChange(SNAP, 'a.ts')
    expect(r.length).toBe(2)
    expect(r[0]).toEqual({ partner: 'partner1.ts', rate: 0.8, sharedCommits: 12 })
    expect(r[1]).toEqual({ partner: 'partner2.ts', rate: 0.5, sharedCommits: 5 })
  })

  it('caps to 20 partners', () => {
    const heavy = {
      coChangePairs: Array.from({ length: 30 }, (_, i) => ({
        a: 'me.ts',
        b: `p${i}.ts`,
        coChangeRate: i / 30,
        sharedCommits: i,
      })),
    }
    expect(extractCoChange(heavy, 'me.ts').length).toBe(20)
  })
})

describe('nodeFromSnap', () => {
  it('returns null when node id is unknown', () => {
    expect(nodeFromSnap(SNAP, 'does-not-exist.ts')).toBeNull()
  })

  it('aggregates all extractors into a single details object', () => {
    const d = nodeFromSnap(SNAP, 'a.ts')
    expect(d).not.toBeNull()
    expect(d!.id).toBe('a.ts')
    expect(d!.type).toBe('file')
    expect(d!.importers).toHaveLength(2)
    expect(d!.imports).toHaveLength(1)
    expect(d!.longFunctions).toHaveLength(2)
    expect(d!.todos).toHaveLength(1)
    expect(d!.envVars).toHaveLength(2)
    expect(d!.driftSignals).toHaveLength(2)
    expect(d!.coChange).toHaveLength(2)
  })
})
