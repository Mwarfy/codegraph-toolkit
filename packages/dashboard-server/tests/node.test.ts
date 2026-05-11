import { describe, it, expect } from 'vitest'
import {
  extractEdges,
  extractLongFunctions,
  extractTodos,
  extractEnvVars,
  extractDriftSignals,
  extractCoChange,
  extractTruthPoint,
  nodeFromSnap,
  type NodeRouteInputs,
} from '../src/routes/node.js'

// Fixture réécrite avec les vrais noms de champs (cf. types réels de
// GraphSnapshot — pré-fix les noms `lines/text/detail/a/b/coChangeRate/
// sharedCommits/var/reason` étaient fakes et ne matchaient aucun fact).
const SNAP: NodeRouteInputs = {
  nodes: [
    { id: 'a.ts', type: 'file', status: 'connected' },
    { id: 'b.ts', type: 'file', status: 'orphan' },
  ],
  edges: [
    { from: 'b.ts', to: 'a.ts', type: 'import' },
    { from: 'c.ts', to: 'a.ts', type: 'import' },
    { from: 'a.ts', to: 'd.ts', type: 'import' },
  ],
  longFunctions: [
    { file: 'a.ts', name: 'big', loc: 120 },
    { file: 'a.ts', name: 'anonymous', loc: 90 },
    { file: 'b.ts', name: 'huge', loc: 200 },
  ],
  todos: [
    { file: 'a.ts', line: 10, message: 'fix this' },
    { file: 'b.ts', line: 5, message: 'unrelated' },
  ],
  envUsage: [
    {
      name: 'API_KEY',
      readers: [
        { file: 'a.ts' },
        { file: 'a.ts' }, // doublon — dédup attendu via Set sur name
      ],
    },
    { name: 'DB_URL', readers: [{ file: 'a.ts' }] },
    { name: 'UNUSED_ELSEWHERE', readers: [{ file: 'other.ts' }] },
  ],
  driftSignals: [
    { file: 'a.ts', kind: 'deep-nesting', message: 'depth 6' },
    { file: 'a.ts', kind: 'wrapper-superfluous', message: 'one-liner wrapper' },
  ],
  coChangePairs: [
    { from: 'a.ts', to: 'partner1.ts', jaccard: 0.8, count: 12 },
    { from: 'partner2.ts', to: 'a.ts', jaccard: 0.5, count: 5 },
    { from: 'unrelated1.ts', to: 'unrelated2.ts', jaccard: 0.9, count: 20 },
  ],
  truthPoints: [
    {
      concept: 'users',
      canonical: { name: 'a.ts' },
      writers: [{ file: 'a.ts' }],
      readers: [{ file: 'b.ts' }],
      mirrors: [],
      exposed: [],
    },
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
  // Fix : champ réel `loc` (pas `lines`). Réponse HTTP garde `lines` en
  // legacy name pour back-compat frontend — c'est le code interne qui
  // mappe loc → lines.
  it('returns long fns scoped to the file (loc → lines mapping)', () => {
    const r = extractLongFunctions(SNAP, 'a.ts')
    expect(r).toEqual([
      { name: 'big', lines: 120 },
      { name: 'anonymous', lines: 90 },
    ])
  })

  // Note : test "uses <anon> when name is missing" supprimé — name est
  // non-optional dans le vrai type, l'extractor garantit toujours un nom.
})

describe('extractTodos', () => {
  // Fix : champ réel `message` (pas `text`). API garde `text` en legacy.
  it('scopes todos to the file (message → text mapping)', () => {
    const r = extractTodos(SNAP, 'a.ts')
    expect(r).toEqual([{ line: 10, text: 'fix this' }])
  })
})

describe('extractEnvVars', () => {
  // Fix structural : envUsage est { name, readers: [{file}] } — pas {file, var}.
  // Le filtre vérifie maintenant si le fichier apparaît dans `readers`.
  it('finds env vars by readers[].file, dedupes by name, sorted', () => {
    expect(extractEnvVars(SNAP, 'a.ts')).toEqual(['API_KEY', 'DB_URL'])
  })

  it('returns empty when no env usage', () => {
    expect(extractEnvVars(SNAP, 'isolated.ts')).toEqual([])
  })

  it('ignores env vars where this file is NOT in readers', () => {
    // UNUSED_ELSEWHERE est dans other.ts, pas a.ts → doit être exclu
    const r = extractEnvVars(SNAP, 'a.ts')
    expect(r).not.toContain('UNUSED_ELSEWHERE')
  })
})

describe('extractDriftSignals', () => {
  // Fix : champ réel `message` (pas `detail`). API garde `detail` en legacy.
  it('emits one tension per signal (message → detail mapping)', () => {
    const r = extractDriftSignals(SNAP, 'a.ts')
    expect(r).toEqual([
      { kind: 'deep-nesting', detail: 'depth 6' },
      { kind: 'wrapper-superfluous', detail: 'one-liner wrapper' },
    ])
  })

  // Note : test "defaults missing kind to 'drift'" supprimé — kind est
  // non-optional dans le vrai type, pas de fallback nécessaire.
})

describe('extractCoChange', () => {
  // Fix : champs réels `from/to/jaccard/count` (pas `a/b/coChangeRate/sharedCommits`).
  // API garde les noms legacy `rate/sharedCommits` mappés depuis jaccard/count.
  it('finds pairs from either side, sorted by rate desc', () => {
    const r = extractCoChange(SNAP, 'a.ts')
    expect(r.length).toBe(2)
    expect(r[0]).toEqual({ partner: 'partner1.ts', rate: 0.8, sharedCommits: 12 })
    expect(r[1]).toEqual({ partner: 'partner2.ts', rate: 0.5, sharedCommits: 5 })
  })

  it('caps to 20 partners', () => {
    const heavy: NodeRouteInputs = {
      nodes: [],
      edges: [],
      coChangePairs: Array.from({ length: 30 }, (_, i) => ({
        from: 'me.ts',
        to: `p${i}.ts`,
        jaccard: i / 30,
        count: i,
      })),
    }
    expect(extractCoChange(heavy, 'me.ts').length).toBe(20)
  })
})

describe('extractTruthPoint', () => {
  // Fix structural massif : `TruthPoint` n'a pas de champ `file`/`reason`.
  // L'extractor cherche le rôle du fichier dans le truth point (canonical
  // > writer > reader > mirror > exposed) et l'expose via `reason` legacy.
  it('detects canonical role (highest priority)', () => {
    expect(extractTruthPoint(SNAP, 'a.ts')).toEqual({
      reason: 'canonical for "users"',
    })
  })

  it('detects reader role', () => {
    expect(extractTruthPoint(SNAP, 'b.ts')).toEqual({
      reason: 'reader for "users"',
    })
  })

  it('returns undefined when file is not part of any truth point', () => {
    expect(extractTruthPoint(SNAP, 'isolated.ts')).toBeUndefined()
  })

  it('returns undefined when no truthPoints at all', () => {
    const empty: NodeRouteInputs = { nodes: [], edges: [] }
    expect(extractTruthPoint(empty, 'a.ts')).toBeUndefined()
  })

  it('writer takes precedence over reader when both apply', () => {
    const both: NodeRouteInputs = {
      nodes: [],
      edges: [],
      truthPoints: [
        {
          concept: 'orders',
          writers: [{ file: 'a.ts' }],
          readers: [{ file: 'a.ts' }],
          mirrors: [],
          exposed: [],
        },
      ],
    }
    expect(extractTruthPoint(both, 'a.ts')).toEqual({
      reason: 'writer for "orders"',
    })
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
    expect(d!.status).toBe('connected')
    expect(d!.importers).toHaveLength(2)
    expect(d!.imports).toHaveLength(1)
    expect(d!.truthPoint).toEqual({ reason: 'canonical for "users"' })
    expect(d!.longFunctions).toHaveLength(2)
    expect(d!.todos).toHaveLength(1)
    expect(d!.envVars).toEqual(['API_KEY', 'DB_URL'])
    expect(d!.driftSignals).toHaveLength(2)
    expect(d!.coChange).toHaveLength(2)
  })
})
