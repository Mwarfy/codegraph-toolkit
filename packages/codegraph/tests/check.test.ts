/**
 * Tests unitaires du module `check` (phase 2 du PLAN.md).
 *
 * Approche : on construit des snapshots synthétiques minimaux (pas de
 * fixture filesystem à parser) pour tester isolément chaque règle. Chaque
 * test est une paire (before, after) : before est un baseline clean,
 * after est une variante volontairement cassante.
 *
 * Invariants testés :
 *   1. Snapshot identique → zéro violation.
 *   2. Nouveau cycle non-gated → règle `no-new-non-gated-cycles` fire.
 *   3. Cycle gated qui devient non-gated → même règle fire.
 *   4. Nouvel état orphelin → règle `no-new-orphan-states` fire.
 *   5. Nouvel état mort → règle `no-new-dead-states` fire.
 *   6. Nouveau truth-point cacheless → règle `no-new-cacheless-truthpoints` fire.
 *   7. Baisse de couverture typed-calls → règle `typed-calls-coverage` fire en warn.
 *   8. Config `off` désactive une règle même si elle détecterait une violation.
 *   9. Config override de sévérité : warn peut être promu error.
 *   10. Déterminisme : deux runs → sortie octet-équivalente.
 *   11. `passed` est false si au moins une violation `error`.
 */

import assert from 'node:assert/strict'
import { runCheck, ALL_RULES } from '../src/check/index.js'
import type { GraphSnapshot, Cycle, StateMachine, TruthPoint } from '../src/core/types.js'

// ─── Snapshot factory ──────────────────────────────────────────────────────

interface SnapshotOverrides {
  cycles?: Cycle[]
  stateMachines?: StateMachine[]
  truthPoints?: TruthPoint[]
  typedCallsSignatures?: number
  files?: number
}

function baseSnapshot(overrides: SnapshotOverrides = {}): GraphSnapshot {
  const files = overrides.files ?? 10
  return {
    version: '1',
    generatedAt: '2026-04-22T00:00:00.000Z',
    rootDir: '/test',
    nodes: [],
    edges: [],
    stats: {
      totalFiles: files,
      totalEdges: 0,
      orphanCount: 0,
      connectedCount: files,
      entryPointCount: 0,
      uncertainCount: 0,
      edgesByType: {
        import: 0, event: 0, route: 0, queue: 0,
        'dynamic-load': 0, 'db-table': 0,
      },
      healthScore: 1,
    },
    cycles: overrides.cycles,
    stateMachines: overrides.stateMachines,
    truthPoints: overrides.truthPoints,
    typedCalls: overrides.typedCallsSignatures !== undefined
      ? { signatures: new Array(overrides.typedCallsSignatures).fill(null).map((_, i) => ({
          file: `f${i}.ts`, exportName: `f${i}`, kind: 'function' as const,
          params: [], returnType: 'void', line: 1,
        })), callEdges: [] }
      : undefined,
  }
}

function cycle(id: string, nodes: string[], gated: boolean): Cycle {
  return {
    id,
    nodes: [...nodes, nodes[0]],
    edges: [],
    gated,
    gates: gated ? [{ file: nodes[0], symbol: 'isAllowed', line: 1 }] : [],
    size: nodes.length,
    sccSize: nodes.length,
  }
}

function fsm(concept: string, states: string[], orphans: string[], dead: string[] = []): StateMachine {
  return {
    concept,
    states,
    transitions: [],
    orphanStates: orphans,
    deadStates: dead,
    detectionConfidence: 'declared-only',
  }
}

function truthPoint(concept: string, hasCanonical: boolean, mirrors: ('redis' | 'memory')[]): TruthPoint {
  return {
    concept,
    canonical: hasCanonical ? { kind: 'table', name: concept } : undefined,
    mirrors: mirrors.map((kind, i) => ({
      kind, key: `${concept}:${i}`, file: 'm.ts', line: 1,
    })),
    writers: [],
    readers: [],
    exposed: [],
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

function testIdentityClean(): void {
  const snap = baseSnapshot({
    cycles: [cycle('c1', ['a.ts', 'b.ts'], false)],
    stateMachines: [fsm('S', ['a', 'b'], ['b'])],
    truthPoints: [truthPoint('t', false, ['redis'])],
    typedCallsSignatures: 50,
  })
  const result = runCheck(snap, snap)
  assert.equal(result.violations.length, 0, 'identical snapshot must produce zero violations')
  assert.equal(result.passed, true)
  assert.ok(result.rulesRun.length >= 4, 'all default-on rules should run')
  console.log('✓ identity: no violations on identical snapshots')
}

function testNewNonGatedCycle(): void {
  const before = baseSnapshot({ cycles: [cycle('c1', ['a.ts', 'b.ts'], false)] })
  const after = baseSnapshot({
    cycles: [
      cycle('c1', ['a.ts', 'b.ts'], false),
      cycle('c2', ['x.ts', 'y.ts'], false),  // new non-gated
    ],
  })
  const result = runCheck(before, after)
  const cycleViolations = result.violations.filter((v) => v.rule === 'no-new-non-gated-cycles')
  assert.equal(cycleViolations.length, 1, 'one new non-gated cycle should fire exactly once')
  assert.equal(cycleViolations[0].severity, 'error')
  assert.ok(cycleViolations[0].message.includes('x.ts'), 'message should reference the new cycle nodes')
  assert.equal(result.passed, false)
  console.log('✓ new non-gated cycle → 1 error')
}

function testGatedToNonGated(): void {
  const before = baseSnapshot({ cycles: [cycle('c1', ['a.ts', 'b.ts'], true)] })
  const after = baseSnapshot({ cycles: [cycle('c1', ['a.ts', 'b.ts'], false)] })
  const result = runCheck(before, after)
  const cycleViolations = result.violations.filter((v) => v.rule === 'no-new-non-gated-cycles')
  assert.equal(cycleViolations.length, 1, 'de-gating a cycle must fire the rule')
  assert.ok(
    cycleViolations[0].message.includes('précédemment gated'),
    'message should flag that the cycle was previously gated',
  )
  console.log('✓ cycle de-gated → 1 error')
}

function testRemovedNonGatedCycleIsNotAViolation(): void {
  const before = baseSnapshot({ cycles: [cycle('c1', ['a.ts', 'b.ts'], false)] })
  const after = baseSnapshot({ cycles: [] })
  const result = runCheck(before, after)
  assert.equal(result.violations.length, 0, 'removing a non-gated cycle is an improvement')
  console.log('✓ removed non-gated cycle → 0 violations')
}

function testNewOrphanState(): void {
  const before = baseSnapshot({
    stateMachines: [fsm('Status', ['pending', 'done'], [])],
  })
  const after = baseSnapshot({
    // Ajout d'un état `archived` à l'enum, mais aucun code ne l'écrit.
    stateMachines: [fsm('Status', ['pending', 'done', 'archived'], ['archived'])],
  })
  const result = runCheck(before, after)
  const orphanViolations = result.violations.filter((v) => v.rule === 'no-new-orphan-states')
  assert.equal(orphanViolations.length, 1)
  assert.ok(orphanViolations[0].message.includes('archived'))
  assert.equal(orphanViolations[0].detail?.concept, 'Status')
  assert.equal(orphanViolations[0].detail?.state, 'archived')
  console.log('✓ new orphan state → 1 error')
}

function testPreExistingOrphanStateIsNotAViolation(): void {
  const before = baseSnapshot({ stateMachines: [fsm('S', ['a', 'b'], ['b'])] })
  const after = baseSnapshot({ stateMachines: [fsm('S', ['a', 'b'], ['b'])] })
  const result = runCheck(before, after)
  assert.equal(result.violations.length, 0, 'pre-existing orphan is not a new violation')
  console.log('✓ pre-existing orphan → 0 violations')
}

function testNewDeadState(): void {
  const before = baseSnapshot({
    stateMachines: [fsm('Phase', ['a', 'b'], [], [])],
  })
  const after = baseSnapshot({
    stateMachines: [fsm('Phase', ['a', 'b'], [], ['b'])],
  })
  const result = runCheck(before, after)
  const deadViolations = result.violations.filter((v) => v.rule === 'no-new-dead-states')
  assert.equal(deadViolations.length, 1)
  assert.ok(deadViolations[0].message.includes('Phase'))
  console.log('✓ new dead state → 1 error')
}

function testNewCachelessTruthPoint(): void {
  const before = baseSnapshot({ truthPoints: [truthPoint('trust_scores', true, ['redis'])] })
  const after = baseSnapshot({
    truthPoints: [
      truthPoint('trust_scores', true, ['redis']),
      truthPoint('cache_only_concept', false, ['redis']),  // new cacheless
    ],
  })
  const result = runCheck(before, after)
  const tpViolations = result.violations.filter((v) => v.rule === 'no-new-cacheless-truthpoints')
  assert.equal(tpViolations.length, 1)
  assert.ok(tpViolations[0].message.includes('cache_only_concept'))
  console.log('✓ new cacheless truth-point → 1 error')
}

function testLostCanonicalTruthPoint(): void {
  const before = baseSnapshot({ truthPoints: [truthPoint('c', true, ['redis'])] })
  const after = baseSnapshot({ truthPoints: [truthPoint('c', false, ['redis'])] })
  const result = runCheck(before, after)
  const tpViolations = result.violations.filter((v) => v.rule === 'no-new-cacheless-truthpoints')
  assert.equal(tpViolations.length, 1, 'losing canonical is a violation')
  assert.ok(tpViolations[0].message.includes('canonique perdue'))
  console.log('✓ lost canonical → 1 error')
}

function testCachelessWithoutMirrorIsNotAViolation(): void {
  const after = baseSnapshot({ truthPoints: [truthPoint('c', false, [])] })
  const result = runCheck(baseSnapshot(), after)
  const tpViolations = result.violations.filter((v) => v.rule === 'no-new-cacheless-truthpoints')
  assert.equal(tpViolations.length, 0, 'concept without mirror and without canonical is noise, ignored')
  console.log('✓ cacheless without mirror → ignored')
}

function testCoverageRegression(): void {
  // 50 sigs / 10 files = 5.0 sigs/file
  // 30 sigs / 10 files = 3.0 sigs/file → drop 200pt clearly > threshold
  const before = baseSnapshot({ typedCallsSignatures: 50, files: 10 })
  const after = baseSnapshot({ typedCallsSignatures: 30, files: 10 })
  const result = runCheck(before, after)
  const covViolations = result.violations.filter((v) => v.rule === 'typed-calls-coverage')
  assert.equal(covViolations.length, 1)
  assert.equal(covViolations[0].severity, 'warn', 'coverage is warn by default')
  assert.equal(result.passed, true, 'warn alone must not fail')
  console.log('✓ coverage regression → 1 warn (passed stays true)')
}

function testCoverageNoRegression(): void {
  const before = baseSnapshot({ typedCallsSignatures: 50, files: 10 })
  const after = baseSnapshot({ typedCallsSignatures: 49, files: 10 })  // tiny drop
  const result = runCheck(before, after)
  const covViolations = result.violations.filter((v) => v.rule === 'typed-calls-coverage')
  assert.equal(covViolations.length, 0, 'small drop below threshold = no warn')
  console.log('✓ coverage tiny drop → 0 warn')
}

function testRuleOff(): void {
  const before = baseSnapshot({ cycles: [] })
  const after = baseSnapshot({ cycles: [cycle('c1', ['a.ts', 'b.ts'], false)] })
  const result = runCheck(before, after, { 'no-new-non-gated-cycles': 'off' })
  const cycleViolations = result.violations.filter((v) => v.rule === 'no-new-non-gated-cycles')
  assert.equal(cycleViolations.length, 0, '`off` disables the rule')
  assert.ok(!result.rulesRun.includes('no-new-non-gated-cycles'))
  console.log('✓ rule off → skipped')
}

function testSeverityOverride(): void {
  const before = baseSnapshot({ typedCallsSignatures: 50, files: 10 })
  const after = baseSnapshot({ typedCallsSignatures: 30, files: 10 })
  const result = runCheck(before, after, { 'typed-calls-coverage': 'error' })
  const covViolations = result.violations.filter((v) => v.rule === 'typed-calls-coverage')
  assert.equal(covViolations.length, 1)
  assert.equal(covViolations[0].severity, 'error', 'override promotes warn → error')
  assert.equal(result.passed, false, 'error causes passed = false')
  console.log('✓ severity override warn → error')
}

function testDeterminism(): void {
  const before = baseSnapshot({ cycles: [] })
  const after = baseSnapshot({
    cycles: [
      cycle('c1', ['a.ts', 'b.ts'], false),
      cycle('c2', ['m.ts', 'n.ts', 'o.ts'], false),
    ],
    stateMachines: [fsm('S', ['p', 'q'], ['q'])],
  })
  const r1 = runCheck(before, after)
  const r2 = runCheck(before, after)
  assert.equal(JSON.stringify(r1), JSON.stringify(r2), 'runCheck must be deterministic')
  console.log('✓ determinism: two runs are byte-equivalent')
}

function testRegistryShape(): void {
  assert.ok(ALL_RULES.length >= 5, 'at least 5 rules registered')
  const names = new Set(ALL_RULES.map((r) => r.name))
  assert.ok(names.has('no-new-non-gated-cycles'))
  assert.ok(names.has('no-new-orphan-states'))
  assert.ok(names.has('no-new-dead-states'))
  assert.ok(names.has('no-new-cacheless-truthpoints'))
  assert.ok(names.has('typed-calls-coverage'))
  console.log(`✓ registry: ${ALL_RULES.length} rules, all required ones present`)
}

// ─── Run ──────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  testIdentityClean()
  testNewNonGatedCycle()
  testGatedToNonGated()
  testRemovedNonGatedCycleIsNotAViolation()
  testNewOrphanState()
  testPreExistingOrphanStateIsNotAViolation()
  testNewDeadState()
  testNewCachelessTruthPoint()
  testLostCanonicalTruthPoint()
  testCachelessWithoutMirrorIsNotAViolation()
  testCoverageRegression()
  testCoverageNoRegression()
  testRuleOff()
  testSeverityOverride()
  testDeterminism()
  testRegistryShape()
  console.log('\n  all check assertions passed')
}

run().catch((err) => {
  console.error('✗ check test failed:')
  console.error(err)
  process.exit(1)
})
