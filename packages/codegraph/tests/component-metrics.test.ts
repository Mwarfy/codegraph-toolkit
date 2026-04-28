/**
 * Tests du component-metrics (phase 3.7 #2).
 */

import assert from 'node:assert/strict'
import { computeComponentMetrics } from '../src/metrics/component-metrics.js'
import type { GraphEdge, GraphNode, ExportSymbol } from '../src/core/types.js'

function node(id: string, exports?: Array<{ name: string; kind: ExportSymbol['kind'] }>): GraphNode {
  return {
    id, label: id, type: 'file', status: 'connected', tags: [],
    exports: exports?.map((e) => ({ name: e.name, kind: e.kind, line: 1, usageCount: 1 })),
  }
}

function edge(from: string, to: string): GraphEdge {
  return { id: `${from}->${to}`, from, to, type: 'import', resolved: true }
}

function testCaCe(): void {
  // 2 composants : `a/x` (1 fichier) et `b/x` (1 fichier). `b/x/f.ts` importe `a/x/g.ts`.
  const nodes = [node('a/x/g.ts'), node('b/x/f.ts')]
  const edges = [edge('b/x/f.ts', 'a/x/g.ts')]
  const m = computeComponentMetrics(nodes, edges, { depth: 2 })
  const ax = m.find((c) => c.component === 'a/x')!
  const bx = m.find((c) => c.component === 'b/x')!
  assert.equal(ax.ca, 1, 'a/x est importé depuis b/x → Ca=1')
  assert.equal(ax.ce, 0, 'a/x n\'importe rien hors → Ce=0')
  assert.equal(bx.ca, 0)
  assert.equal(bx.ce, 1, 'b/x importe a/x → Ce=1')
  console.log('✓ Ca / Ce cross-component counts correct')
}

function testInstabilityFormula(): void {
  // Composant avec Ca=3, Ce=1 → I = 1/4 = 0.25 (stable)
  const nodes = [
    node('lib/x/f.ts'), node('lib/x/g.ts'),
    node('app/a.ts'), node('app/b.ts'), node('app/c.ts'),
  ]
  const edges = [
    edge('app/a.ts', 'lib/x/f.ts'),
    edge('app/b.ts', 'lib/x/f.ts'),
    edge('app/c.ts', 'lib/x/g.ts'),
    edge('lib/x/f.ts', 'app/a.ts'),  // Ce = 1
  ]
  const m = computeComponentMetrics(nodes, edges, { depth: 2 })
  const lib = m.find((c) => c.component === 'lib/x')!
  assert.equal(lib.ca, 3)
  assert.equal(lib.ce, 1)
  assert.equal(lib.instability, 0.25)
  console.log('✓ Instability = Ce/(Ca+Ce)')
}

function testAbstractness(): void {
  // Composant : 2 interfaces + 1 type + 3 classes + 4 functions = 8 total, 3 abstract.
  const nodes = [
    node('lib/y/a.ts', [
      { name: 'I1', kind: 'interface' },
      { name: 'T1', kind: 'type' },
      { name: 'C1', kind: 'class' },
      { name: 'f1', kind: 'function' },
    ]),
    node('lib/y/b.ts', [
      { name: 'I2', kind: 'interface' },
      { name: 'C2', kind: 'class' },
      { name: 'C3', kind: 'class' },
      { name: 'f2', kind: 'function' },
      { name: 'f3', kind: 'function' },
    ]),
    node('outside.ts'),  // pour avoir au moins un edge externe
  ]
  const edges = [edge('outside.ts', 'lib/y/a.ts')]
  const m = computeComponentMetrics(nodes, edges, { depth: 2 })
  const lib = m.find((c) => c.component === 'lib/y')!
  assert.equal(lib.exportCount, 9)
  assert.equal(lib.abstractness, Number((3 / 9).toFixed(4)), `A=${lib.abstractness}`)
  console.log('✓ Abstractness = abstract/total (interface + type + enum counted)')
}

function testDistanceFromMainSequence(): void {
  // I=0, A=1 → D = |1 + 0 − 1| = 0 (stable abstract, ideal base).
  const nodes = [
    node('contracts/iface.ts', [{ name: 'MyIface', kind: 'interface' }]),
    node('user.ts'),
  ]
  const edges = [edge('user.ts', 'contracts/iface.ts')]
  const m = computeComponentMetrics(nodes, edges, { depth: 1 })
  const contracts = m.find((c) => c.component === 'contracts')!
  assert.equal(contracts.instability, 0)
  assert.equal(contracts.abstractness, 1)
  assert.equal(contracts.distance, 0, 'stable abstract base is on the main sequence')
  console.log('✓ Distance = |A+I−1| = 0 on stable abstract base')
}

function testZoneOfPain(): void {
  // I=0 (tout le monde dépend), A=0 (concret) → D = 1.
  const nodes = [
    node('impl/x.ts', [{ name: 'BigClass', kind: 'class' }]),
    node('a.ts'), node('b.ts'), node('c.ts'),
  ]
  const edges = [
    edge('a.ts', 'impl/x.ts'),
    edge('b.ts', 'impl/x.ts'),
    edge('c.ts', 'impl/x.ts'),
  ]
  const m = computeComponentMetrics(nodes, edges, { depth: 1 })
  const impl = m.find((c) => c.component === 'impl')!
  assert.equal(impl.instability, 0)
  assert.equal(impl.abstractness, 0)
  assert.equal(impl.distance, 1, 'pure zone of pain → D=1')
  console.log('✓ Zone of pain (stable + concrete) → D = 1')
}

function testIntraComponentEdgesIgnored(): void {
  const nodes = [
    node('pkg/a.ts'), node('pkg/b.ts'), node('pkg/c.ts'),
  ]
  const edges = [
    edge('pkg/a.ts', 'pkg/b.ts'),
    edge('pkg/b.ts', 'pkg/c.ts'),
  ]
  const m = computeComponentMetrics(nodes, edges, { depth: 1 })
  const pkg = m.find((c) => c.component === 'pkg')!
  assert.equal(pkg.ca, 0, 'intra-component edges must not feed Ca')
  assert.equal(pkg.ce, 0, 'intra-component edges must not feed Ce')
  console.log('✓ Intra-component edges ignored for Ca/Ce')
}

function testDeterminism(): void {
  const nodes = [
    node('a/x.ts', [{ name: 'F', kind: 'function' }]),
    node('b/y.ts'),
  ]
  const edges = [edge('b/y.ts', 'a/x.ts')]
  const m1 = computeComponentMetrics(nodes, edges, { depth: 1 })
  const m2 = computeComponentMetrics(nodes, edges, { depth: 1 })
  assert.equal(JSON.stringify(m1), JSON.stringify(m2))
  console.log('✓ deterministic output')
}

async function run(): Promise<void> {
  testCaCe()
  testInstabilityFormula()
  testAbstractness()
  testDistanceFromMainSequence()
  testZoneOfPain()
  testIntraComponentEdgesIgnored()
  testDeterminism()
  console.log('\n  all component-metrics assertions passed')
}

run().catch((err) => {
  console.error('✗ component-metrics test failed:')
  console.error(err)
  process.exit(1)
})
