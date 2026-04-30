/**
 * Tests unitaires du module `diff` structurel (phase 3 du PLAN.md).
 *
 * Approche : snapshots synthétiques minimaux, un test par dimension (cycles,
 * typedCalls, stateMachines, truthPoints, dataFlows) + 2 tests transverses
 * (déterminisme, rendu markdown).
 */

import assert from 'node:assert/strict'
import { buildStructuralDiff, renderStructuralDiffMarkdown } from '../src/diff/index.js'
import type {
  Cycle,
  DataFlow,
  GraphSnapshot,
  StateMachine,
  StateTransition,
  TruthPoint,
  TypedSignature,
  TypedCallEdge,
} from '../src/core/types.js'

// ─── Factories ─────────────────────────────────────────────────────────────

interface Overrides {
  cycles?: Cycle[]
  typedCalls?: { signatures: TypedSignature[]; callEdges: TypedCallEdge[] }
  stateMachines?: StateMachine[]
  truthPoints?: TruthPoint[]
  dataFlows?: DataFlow[]
}

function snap(overrides: Overrides = {}): GraphSnapshot {
  return {
    version: '1',
    generatedAt: '2026-04-22T00:00:00.000Z',
    rootDir: '/test',
    nodes: [],
    edges: [],
    stats: {
      totalFiles: 0, totalEdges: 0, orphanCount: 0, connectedCount: 0,
      entryPointCount: 0, uncertainCount: 0,
      edgesByType: { import: 0, event: 0, route: 0, queue: 0, 'dynamic-load': 0, 'db-table': 0 },
      healthScore: 1,
    },
    cycles: overrides.cycles,
    typedCalls: overrides.typedCalls,
    stateMachines: overrides.stateMachines,
    truthPoints: overrides.truthPoints,
    dataFlows: overrides.dataFlows,
  }
}

function cycle(id: string, nodes: string[], gated: boolean): Cycle {
  return {
    id, nodes: [...nodes, nodes[0]], edges: [],
    gated, gates: [], size: nodes.length, sccSize: nodes.length,
  }
}

function sig(
  file: string,
  name: string,
  params: Array<[string, string, boolean?]>,
  returnType: string,
): TypedSignature {
  return {
    file, exportName: name, kind: 'function',
    params: params.map(([n, t, o]) => ({ name: n, type: t, optional: o ?? false })),
    returnType, line: 1,
  }
}

function transition(from: string, to: string, triggerKind: StateTransition['trigger']['kind'], triggerId: string, file: string, line: number): StateTransition {
  return { from, to, trigger: { kind: triggerKind, id: triggerId }, file, line }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

function testEmptyDiff(): void {
  const d = buildStructuralDiff(snap(), snap())
  assert.equal(d.cycles.added.length, 0)
  assert.equal(d.typedCalls.addedSignatures.length, 0)
  assert.equal(d.stateMachines.added.length, 0)
  assert.equal(d.truthPoints.added.length, 0)
  assert.equal(d.dataFlows.added.length, 0)
  assert.equal(d.summary.cyclesAdded, 0)
  console.log('✓ empty → empty structural diff')
}

function testCyclesAddedRemoved(): void {
  const before = snap({ cycles: [cycle('c1', ['a', 'b'], false)] })
  const after = snap({ cycles: [cycle('c2', ['x', 'y'], false)] })
  const d = buildStructuralDiff(before, after)
  assert.equal(d.cycles.added.length, 1)
  assert.equal(d.cycles.added[0].id, 'c2')
  assert.equal(d.cycles.removed.length, 1)
  assert.equal(d.cycles.removed[0].id, 'c1')
  assert.equal(d.cycles.gatingChanged.length, 0)
  console.log('✓ cycles: added + removed')
}

function testCyclesGatingChange(): void {
  const before = snap({ cycles: [cycle('c1', ['a', 'b'], true)] })
  const after = snap({ cycles: [cycle('c1', ['a', 'b'], false)] })
  const d = buildStructuralDiff(before, after)
  assert.equal(d.cycles.added.length, 0)
  assert.equal(d.cycles.removed.length, 0)
  assert.equal(d.cycles.gatingChanged.length, 1)
  assert.equal(d.cycles.gatingChanged[0].wasGated, true)
  assert.equal(d.cycles.gatingChanged[0].nowGated, false)
  console.log('✓ cycles: gating flip detected')
}

function testTypedCallsAddedRemoved(): void {
  const before = snap({
    typedCalls: { signatures: [sig('a.ts', 'foo', [['x', 'string']], 'number')], callEdges: [] },
  })
  const after = snap({
    typedCalls: { signatures: [sig('b.ts', 'bar', [], 'void')], callEdges: [] },
  })
  const d = buildStructuralDiff(before, after)
  assert.equal(d.typedCalls.addedSignatures.length, 1)
  assert.equal(d.typedCalls.addedSignatures[0].exportName, 'bar')
  assert.equal(d.typedCalls.removedSignatures.length, 1)
  assert.equal(d.typedCalls.removedSignatures[0].exportName, 'foo')
  console.log('✓ typed calls: added + removed sigs')
}

function testTypedCallsBreakingRemoved(): void {
  // foo(x: string, y: number) → foo(x: string)  — param removed = breaking
  const before = snap({
    typedCalls: {
      signatures: [sig('a.ts', 'foo', [['x', 'string'], ['y', 'number']], 'void')],
      callEdges: [],
    },
  })
  const after = snap({
    typedCalls: {
      signatures: [sig('a.ts', 'foo', [['x', 'string']], 'void')],
      callEdges: [],
    },
  })
  const d = buildStructuralDiff(before, after)
  assert.equal(d.typedCalls.modifiedSignatures.length, 1)
  const mod = d.typedCalls.modifiedSignatures[0]
  assert.equal(mod.breaking, true)
  assert.ok(mod.breakingReasons.includes('param-removed'))
  assert.equal(d.summary.signaturesBreaking, 1)
  console.log('✓ typed calls: param-removed = breaking')
}

function testTypedCallsBreakingReturn(): void {
  const before = snap({
    typedCalls: {
      signatures: [sig('a.ts', 'foo', [['x', 'string']], 'Foo')],
      callEdges: [],
    },
  })
  const after = snap({
    typedCalls: {
      signatures: [sig('a.ts', 'foo', [['x', 'string']], 'Bar')],
      callEdges: [],
    },
  })
  const d = buildStructuralDiff(before, after)
  assert.equal(d.typedCalls.modifiedSignatures.length, 1)
  assert.equal(d.typedCalls.modifiedSignatures[0].breaking, true)
  assert.ok(d.typedCalls.modifiedSignatures[0].breakingReasons.includes('return-changed'))
  console.log('✓ typed calls: return-changed = breaking')
}

function testTypedCallsNonBreakingOptionalAdd(): void {
  // foo(x) → foo(x, y?: string) — optional param added = non-breaking
  const before = snap({
    typedCalls: {
      signatures: [sig('a.ts', 'foo', [['x', 'string']], 'void')],
      callEdges: [],
    },
  })
  const after = snap({
    typedCalls: {
      signatures: [sig('a.ts', 'foo', [['x', 'string'], ['y', 'string', true]], 'void')],
      callEdges: [],
    },
  })
  const d = buildStructuralDiff(before, after)
  assert.equal(d.typedCalls.modifiedSignatures.length, 1)
  assert.equal(
    d.typedCalls.modifiedSignatures[0].breaking,
    false,
    'adding an optional param must not be breaking',
  )
  console.log('✓ typed calls: +optional param is non-breaking')
}

function testTypedCallsCallEdgeCounts(): void {
  const before = snap({
    typedCalls: {
      signatures: [],
      callEdges: [{ from: 'a:x', to: 'b:y', argTypes: [], returnType: 'void', line: 1 }],
    },
  })
  const after = snap({
    typedCalls: {
      signatures: [],
      callEdges: [
        { from: 'c:p', to: 'd:q', argTypes: [], returnType: 'void', line: 5 },
        { from: 'e:r', to: 'f:s', argTypes: [], returnType: 'void', line: 10 },
      ],
    },
  })
  const d = buildStructuralDiff(before, after)
  assert.equal(d.typedCalls.callEdgesAdded, 2)
  assert.equal(d.typedCalls.callEdgesRemoved, 1)
  console.log('✓ typed calls: call edge counts')
}

function testStateMachinesAddedStateAndTransition(): void {
  const fsmBefore: StateMachine = {
    concept: 'S', states: ['a', 'b'],
    transitions: [transition('*', 'a', 'init', '', 'f.ts', 1)],
    orphanStates: [], deadStates: [],
    detectionConfidence: 'observed',
  }
  const fsmAfter: StateMachine = {
    concept: 'S', states: ['a', 'b', 'c'],
    transitions: [
      transition('*', 'a', 'init', '', 'f.ts', 1),
      transition('*', 'c', 'event', 'foo', 'f.ts', 10),
    ],
    orphanStates: ['c'],
    deadStates: [],
    detectionConfidence: 'observed',
  }
  const d = buildStructuralDiff(snap({ stateMachines: [fsmBefore] }), snap({ stateMachines: [fsmAfter] }))
  assert.equal(d.stateMachines.changed.length, 1)
  const c = d.stateMachines.changed[0]
  assert.deepEqual(c.statesAdded, ['c'])
  assert.equal(c.transitionsAdded.length, 1)
  assert.equal(c.transitionsAdded[0].to, 'c')
  assert.deepEqual(c.orphansAdded, ['c'])
  console.log('✓ state machines: +state, +transition, +orphan detected')
}

function testTruthPointsCanonicalLost(): void {
  const before = snap({ truthPoints: [{
    concept: 'c', canonical: { kind: 'table', name: 'c' },
    mirrors: [], writers: [], readers: [], exposed: [],
  }] })
  const after = snap({ truthPoints: [{
    concept: 'c', mirrors: [], writers: [], readers: [], exposed: [],
  }] })
  const d = buildStructuralDiff(before, after)
  assert.equal(d.truthPoints.changed.length, 1)
  assert.equal(d.truthPoints.changed[0].canonicalBefore, 'c')
  assert.equal(d.truthPoints.changed[0].canonicalAfter, null)
  console.log('✓ truth points: canonical loss detected')
}

function testTruthPointsMirrorAdded(): void {
  const before = snap({ truthPoints: [{
    concept: 'c', canonical: { kind: 'table', name: 'c' },
    mirrors: [], writers: [], readers: [], exposed: [],
  }] })
  const after = snap({ truthPoints: [{
    concept: 'c', canonical: { kind: 'table', name: 'c' },
    mirrors: [{ kind: 'redis', key: 'c:1', file: 'x.ts', line: 5 }],
    writers: [], readers: [], exposed: [],
  }] })
  const d = buildStructuralDiff(before, after)
  assert.equal(d.truthPoints.changed.length, 1)
  assert.equal(d.truthPoints.changed[0].mirrorsAdded.length, 1)
  assert.equal(d.truthPoints.changed[0].canonicalBefore, 'c')
  assert.equal(d.truthPoints.changed[0].canonicalAfter, 'c')
  console.log('✓ truth points: +mirror detected without canonical noise')
}

function testDataFlowsAdded(): void {
  const flow: DataFlow = {
    entry: { kind: 'http-route', id: 'POST /api/foo', file: 'r.ts', line: 1 },
    steps: [], sinks: [],
  }
  const d = buildStructuralDiff(snap(), snap({ dataFlows: [flow] }))
  assert.equal(d.dataFlows.added.length, 1)
  assert.equal(d.dataFlows.added[0].id, 'POST /api/foo')
  console.log('✓ data flows: new entry-point detected')
}

function testDataFlowsSinkAdded(): void {
  const flowBefore: DataFlow = {
    entry: { kind: 'http-route', id: 'POST /api/foo', file: 'r.ts', line: 1 },
    steps: [], sinks: [],
  }
  const flowAfter: DataFlow = {
    ...flowBefore,
    sinks: [{ kind: 'db-write', target: 'users', file: 'r.ts', line: 3, container: 'r:handler' }],
  }
  const d = buildStructuralDiff(snap({ dataFlows: [flowBefore] }), snap({ dataFlows: [flowAfter] }))
  assert.equal(d.dataFlows.changed.length, 1)
  assert.equal(d.dataFlows.changed[0].sinksAdded.length, 1)
  assert.equal(d.dataFlows.changed[0].sinksAdded[0].target, 'users')
  console.log('✓ data flows: +sink detected on existing entry')
}

function testDeterminism(): void {
  const before = snap({
    cycles: [cycle('c1', ['a', 'b'], false)],
    stateMachines: [{
      concept: 'S', states: ['a', 'b'], transitions: [],
      orphanStates: ['b'], deadStates: [],
    }],
  })
  const after = snap({
    cycles: [cycle('c1', ['a', 'b'], false), cycle('c2', ['m', 'n'], false)],
    stateMachines: [{
      concept: 'S', states: ['a', 'b', 'c'], transitions: [],
      orphanStates: ['b', 'c'], deadStates: [],
    }],
  })
  // Forcer la même `generatedAt` en mettant la même horloge — `buildStructuralDiff`
  // écrit `new Date().toISOString()`, donc on reset après le premier run.
  const r1 = buildStructuralDiff(before, after)
  const r2 = buildStructuralDiff(before, after)
  r1.generatedAt = 'X'; r2.generatedAt = 'X'
  assert.equal(JSON.stringify(r1), JSON.stringify(r2), 'structural diff must be deterministic')
  console.log('✓ determinism: two runs are byte-equivalent (modulo timestamp)')
}

function testMarkdownRenderCleanDiff(): void {
  const md = renderStructuralDiffMarkdown(buildStructuralDiff(snap(), snap()))
  assert.ok(md.includes('# Structural Diff'))
  assert.ok(md.includes('## Summary'))
  assert.ok(md.includes('_Aucun changement structurel._'))
  console.log('✓ markdown: empty diff renders no-change placeholder')
}

// ─── Phase 3.5 — line-insensitive matching ────────────────────────────────

function testTruthPointsIgnoreLineShifts(): void {
  // Même writer, même fichier, même symbole, ligne différente → doit
  // matcher (0 add / 0 remove).
  const before = snap({ truthPoints: [{
    concept: 'c', canonical: { kind: 'table', name: 'c' },
    mirrors: [], writers: [{ file: 'a.ts', symbol: 'w', line: 10 }],
    readers: [], exposed: [],
  }] })
  const after = snap({ truthPoints: [{
    concept: 'c', canonical: { kind: 'table', name: 'c' },
    mirrors: [], writers: [{ file: 'a.ts', symbol: 'w', line: 42 }],
    readers: [], exposed: [],
  }] })
  const d = buildStructuralDiff(before, after)
  assert.equal(d.truthPoints.changed.length, 0, 'line shift alone must not trigger a truth-point change')
  console.log('✓ phase 3.5: truth-point writer line shift → ignored')
}

function testStateMachinesIgnoreTransitionLineShifts(): void {
  // Même transition logique à une ligne différente → 0 add / 0 remove.
  const fsmBefore: StateMachine = {
    concept: 'S', states: ['a'],
    transitions: [transition('*', 'a', 'event', 'foo', 'f.ts', 10)],
    orphanStates: [], deadStates: [],
    detectionConfidence: 'observed',
  }
  const fsmAfter: StateMachine = {
    concept: 'S', states: ['a'],
    transitions: [transition('*', 'a', 'event', 'foo', 'f.ts', 42)],
    orphanStates: [], deadStates: [],
    detectionConfidence: 'observed',
  }
  const d = buildStructuralDiff(snap({ stateMachines: [fsmBefore] }), snap({ stateMachines: [fsmAfter] }))
  assert.equal(d.stateMachines.changed.length, 0, 'line shift alone must not trigger a FSM change')
  console.log('✓ phase 3.5: FSM transition line shift → ignored')
}

function testDataFlowsIgnoreSinkLineShifts(): void {
  const flowBefore: DataFlow = {
    entry: { kind: 'http-route', id: 'POST /x', file: 'r.ts', line: 1 },
    steps: [],
    sinks: [{ kind: 'db-write', target: 'users', file: 'r.ts', line: 5, container: 'h' }],
  }
  const flowAfter: DataFlow = {
    ...flowBefore,
    sinks: [{ kind: 'db-write', target: 'users', file: 'r.ts', line: 42, container: 'h' }],
  }
  const d = buildStructuralDiff(snap({ dataFlows: [flowBefore] }), snap({ dataFlows: [flowAfter] }))
  assert.equal(d.dataFlows.changed.length, 0, 'sink line shift alone must not trigger a flow change')
  console.log('✓ phase 3.5: data-flow sink line shift → ignored')
}

function testTypedCallsIgnoreCallEdgeLineShifts(): void {
  // Même (from → to) à des lignes différentes : edge compté 1× stable.
  const before = snap({
    typedCalls: {
      signatures: [],
      callEdges: [{ from: 'a:x', to: 'b:y', argTypes: [], returnType: 'void', line: 10 }],
    },
  })
  const after = snap({
    typedCalls: {
      signatures: [],
      callEdges: [{ from: 'a:x', to: 'b:y', argTypes: [], returnType: 'void', line: 42 }],
    },
  })
  const d = buildStructuralDiff(before, after)
  assert.equal(d.typedCalls.callEdgesAdded, 0, 'line-only shift must not count as added edge')
  assert.equal(d.typedCalls.callEdgesRemoved, 0, 'line-only shift must not count as removed edge')
  console.log('✓ phase 3.5: call edge line shift → ignored')
}

function testMarkdownRenderWithContent(): void {
  const before = snap({
    cycles: [cycle('c1', ['a', 'b'], true)],
    typedCalls: {
      signatures: [sig('a.ts', 'foo', [['x', 'string']], 'void')],
      callEdges: [],
    },
  })
  const after = snap({
    cycles: [cycle('c1', ['a', 'b'], false), cycle('c2', ['m', 'n'], false)],
    typedCalls: {
      signatures: [sig('b.ts', 'bar', [], 'number')],
      callEdges: [],
    },
  })
  const md = renderStructuralDiffMarkdown(buildStructuralDiff(before, after))
  assert.ok(md.includes('## Cycles'))
  assert.ok(md.includes('### Added'))
  assert.ok(md.includes('c2'))
  assert.ok(md.includes('### Gating changed'))
  assert.ok(md.includes('## Typed Calls'))
  assert.ok(md.includes('b.ts:bar'))
  console.log('✓ markdown: content sections render')
}

// ─── Run ──────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  testEmptyDiff()
  testCyclesAddedRemoved()
  testCyclesGatingChange()
  testTypedCallsAddedRemoved()
  testTypedCallsBreakingRemoved()
  testTypedCallsBreakingReturn()
  testTypedCallsNonBreakingOptionalAdd()
  testTypedCallsCallEdgeCounts()
  testStateMachinesAddedStateAndTransition()
  testTruthPointsCanonicalLost()
  testTruthPointsMirrorAdded()
  testDataFlowsAdded()
  testDataFlowsSinkAdded()
  testDeterminism()
  testTruthPointsIgnoreLineShifts()
  testStateMachinesIgnoreTransitionLineShifts()
  testDataFlowsIgnoreSinkLineShifts()
  testTypedCallsIgnoreCallEdgeLineShifts()
  testMarkdownRenderCleanDiff()
  testMarkdownRenderWithContent()
  console.log('\n  all structural diff assertions passed')
}

run().catch((err) => {
  console.error('✗ diff-structural test failed:')
  console.error(err)
  process.exit(1)
})
