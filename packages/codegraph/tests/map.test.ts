/**
 * Test du map builder — section presence + déterminisme.
 *
 * Construit un snapshot synthétique minimal puis vérifie :
 *   1. Toutes les sections sont présentes quand les données sont là.
 *   2. Les sections dont les données manquent sont omises sans erreur.
 *   3. Les deux appels successifs produisent une sortie octet-équivalente.
 */

import assert from 'node:assert/strict'
import { buildMap } from '../src/map/builder.js'
import type { GraphSnapshot } from '../src/core/types.js'

function makeMinimalSnapshot(): GraphSnapshot {
  return {
    version: '1',
    generatedAt: '2026-04-22T00:00:00.000Z',
    commitHash: 'abc1234567890',
    rootDir: '/tmp/demo-project',
    nodes: [
      { id: 'a.ts', label: 'a.ts', type: 'file', status: 'connected', tags: [] },
      { id: 'b.ts', label: 'b.ts', type: 'file', status: 'entry-point', tags: [] },
    ],
    edges: [
      { id: 'b.ts--import--a.ts', from: 'b.ts', to: 'a.ts', type: 'import', resolved: true },
      { id: 'a.ts--event--b.ts', from: 'a.ts', to: 'b.ts', type: 'event', resolved: true, label: 'hello.world' },
      { id: 'a.ts--db-table--b.ts', from: 'a.ts', to: 'b.ts', type: 'db-table', resolved: true, label: 'table:widgets' },
    ],
    stats: {
      totalFiles: 2,
      totalEdges: 3,
      orphanCount: 0,
      connectedCount: 1,
      entryPointCount: 1,
      uncertainCount: 0,
      edgesByType: { import: 1, event: 1, route: 0, queue: 0, 'dynamic-load': 0, 'db-table': 1 },
      healthScore: 1,
    },
  }
}

function fullSnapshot(): GraphSnapshot {
  const s = makeMinimalSnapshot()
  s.typedCalls = {
    signatures: [
      { file: 'a.ts', exportName: 'doThing', kind: 'function', params: [{ name: 'x', type: 'number', optional: false }], returnType: 'string', line: 10 },
    ],
    callEdges: [
      { from: 'b.ts:main', to: 'a.ts:doThing', argTypes: ['number'], returnType: 'string', line: 5 },
    ],
  }
  s.cycles = [
    {
      id: 'cyc1',
      nodes: ['a.ts', 'b.ts', 'a.ts'],
      edges: [
        { from: 'a.ts', to: 'b.ts', type: 'event', label: 'hello.world' },
        { from: 'b.ts', to: 'a.ts', type: 'import' },
      ],
      gated: false,
      gates: [],
      size: 2,
      sccSize: 2,
    },
  ]
  s.truthPoints = [
    {
      concept: 'widgets',
      canonical: { kind: 'table', name: 'widgets' },
      mirrors: [],
      writers: [{ file: 'a.ts', symbol: 'doThing', line: 10 }],
      readers: [{ file: 'b.ts', symbol: 'main', line: 5 }],
      exposed: [{ kind: 'function', id: 'getWidget', file: 'b.ts', line: 6 }],
    },
  ]
  s.dataFlows = [
    {
      entry: { kind: 'http-route', id: 'GET /api/x', file: 'b.ts', line: 2, handler: 'b.ts:main' },
      steps: [{ node: 'b.ts:main', file: 'b.ts', symbol: 'main', line: 2, depth: 0, inputTypes: [] }],
      sinks: [{ kind: 'db-write', target: 'widgets', file: 'a.ts', line: 10, container: 'a.ts:doThing' }],
    },
  ]
  s.stateMachines = [
    {
      concept: 'WidgetStatus',
      states: ['pending', 'done'],
      transitions: [{ from: '*', to: 'done', trigger: { kind: 'init', id: '' }, file: 'a.ts', line: 10 }],
      orphanStates: ['pending'],
      deadStates: [],
    },
  ]
  return s
}

function run(): void {
  // ─── 1. Full snapshot : toutes les sections présentes ───────────────
  const full = fullSnapshot()
  const mdFull = buildMap(full)
  for (const heading of [
    '## 0. Stats',
    '## 1. Core flows',
    '## 2. State machines',
    '## 3. Truth points',
    '## 4. Cycles',
    '## 5. Modules',
    '## 6. Index',
  ]) {
    assert.ok(
      mdFull.includes(heading),
      `missing section: ${heading}\nMAP excerpt:\n${mdFull.slice(0, 500)}`,
    )
  }
  assert.ok(mdFull.includes('WidgetStatus'), 'state machine concept missing')
  assert.ok(mdFull.includes('widgets'), 'truth point concept missing')
  assert.ok(mdFull.includes('GET /api/x'), 'data flow entry missing')
  assert.ok(mdFull.includes('hello.world'), 'event label missing from index')

  // ─── 2. Minimal snapshot : sections phase 1 omises ──────────────────
  const mini = makeMinimalSnapshot()
  const mdMini = buildMap(mini)
  assert.ok(mdMini.includes('## 0. Stats'))
  assert.ok(mdMini.includes('## 5. Modules'), 'section 5 (modules) should always be present')
  assert.ok(!mdMini.includes('## 1. Core flows'), '## 1 should be omitted when no dataFlows')
  assert.ok(!mdMini.includes('## 2. State machines'), '## 2 should be omitted when no stateMachines')
  assert.ok(!mdMini.includes('## 3. Truth points'), '## 3 should be omitted when no truthPoints')
  assert.ok(!mdMini.includes('## 4. Cycles'), '## 4 should be omitted when no cycles')
  // L'index section 6 peut apparaître (event edges présents).
  assert.ok(mdMini.includes('## 6. Index'))

  // ─── 3. Déterminisme ────────────────────────────────────────────────
  const mdFull2 = buildMap(fullSnapshot())
  assert.equal(mdFull, mdFull2, 'buildMap not byte-equivalent for same snapshot')

  console.log(`✓ map: full=${mdFull.length} chars, mini=${mdMini.length} chars`)
  console.log('  all assertions passed')
}

try {
  run()
} catch (err) {
  console.error('✗ map test failed:')
  console.error(err)
  process.exit(1)
}
