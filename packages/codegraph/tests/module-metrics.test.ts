/**
 * Tests du module-metrics (phase 3.7 #5 + #6).
 * Pure arithmétique sur le snapshot — pas de fixture disque nécessaire.
 */

import assert from 'node:assert/strict'
import { computeModuleMetrics } from '../src/metrics/module-metrics.js'
import type { GraphEdge, GraphNode } from '../src/core/types.js'

function node(id: string, loc = 0): GraphNode {
  return { id, label: id, type: 'file', status: 'connected', tags: [], loc }
}

function edge(from: string, to: string, type: GraphEdge['type'] = 'import'): GraphEdge {
  return { id: `${from}--${type}--${to}`, from, to, type, resolved: true }
}

function testFanInFanOut(): void {
  // Topology :  a → b, a → c, b → c
  const nodes = [node('a.ts'), node('b.ts'), node('c.ts')]
  const edges = [edge('a.ts', 'b.ts'), edge('a.ts', 'c.ts'), edge('b.ts', 'c.ts')]
  const m = computeModuleMetrics(nodes, edges)
  const byFile = new Map(m.map((x) => [x.file, x]))
  assert.equal(byFile.get('a.ts')!.fanOut, 2)
  assert.equal(byFile.get('a.ts')!.fanIn, 0)
  assert.equal(byFile.get('b.ts')!.fanIn, 1)
  assert.equal(byFile.get('b.ts')!.fanOut, 1)
  assert.equal(byFile.get('c.ts')!.fanIn, 2)
  assert.equal(byFile.get('c.ts')!.fanOut, 0)
  console.log('✓ fanIn / fanOut counts correct on simple DAG')
}

function testEdgeTypeFilter(): void {
  // Seuls les edges `import` comptent par défaut ; `event` exclu.
  const nodes = [node('a.ts'), node('b.ts')]
  const edges = [edge('a.ts', 'b.ts', 'import'), edge('a.ts', 'b.ts', 'event')]
  const m = computeModuleMetrics(nodes, edges)
  const byFile = new Map(m.map((x) => [x.file, x]))
  assert.equal(byFile.get('b.ts')!.fanIn, 1, 'event edges must not contribute to import fanIn')
  console.log('✓ edge type filter: `import` only by default')
}

function testPageRankHubBeatsLeaf(): void {
  // Hub `h` importé par 5 autres fichiers → doit avoir le PR max.
  const nodes = ['h.ts', 'a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'].map((id) => node(id))
  const edges = ['a', 'b', 'c', 'd', 'e'].map((x) => edge(`${x}.ts`, 'h.ts'))
  const m = computeModuleMetrics(nodes, edges)
  // h doit être en tête du tri (PageRank desc).
  assert.equal(m[0].file, 'h.ts')
  assert.equal(m[0].pageRank, 1.0, 'hub should get normalized PR = 1.0')
  // Les leaves ont un PR strictement inférieur.
  for (const other of m.slice(1)) assert.ok(other.pageRank < 1.0)
  console.log('✓ PageRank ranks hub above leaves')
}

function testHenryKafuraFormula(): void {
  // fanIn=3, fanOut=4, loc=100 → (3×4)² × 100 = 14_400
  const nodes = [
    node('h.ts', 100),
    node('a.ts'), node('b.ts'), node('c.ts'),  // importers
    node('x.ts'), node('y.ts'), node('z.ts'), node('w.ts'),  // imported
  ]
  const edges = [
    edge('a.ts', 'h.ts'), edge('b.ts', 'h.ts'), edge('c.ts', 'h.ts'),
    edge('h.ts', 'x.ts'), edge('h.ts', 'y.ts'), edge('h.ts', 'z.ts'), edge('h.ts', 'w.ts'),
  ]
  const m = computeModuleMetrics(nodes, edges)
  const h = m.find((x) => x.file === 'h.ts')!
  assert.equal(h.fanIn, 3)
  assert.equal(h.fanOut, 4)
  assert.equal(h.loc, 100)
  assert.equal(h.henryKafura, (3 * 4) ** 2 * 100, 'HK formula (fanIn*fanOut)² × loc')
  console.log('✓ Henry-Kafura = (fanIn × fanOut)² × loc')
}

function testHenryKafuraZeroOnLeafOrRoot(): void {
  // Pur leaf (fanOut=0) ou pur root (fanIn=0) → HK = 0 (pas de flux).
  const nodes = [node('leaf.ts', 500), node('root.ts', 500), node('mid.ts', 500)]
  const edges = [edge('root.ts', 'mid.ts'), edge('mid.ts', 'leaf.ts')]
  const m = computeModuleMetrics(nodes, edges)
  const byFile = new Map(m.map((x) => [x.file, x]))
  assert.equal(byFile.get('leaf.ts')!.henryKafura, 0, 'leaf: fanOut=0 → HK=0')
  assert.equal(byFile.get('root.ts')!.henryKafura, 0, 'root: fanIn=0 → HK=0')
  assert.ok(byFile.get('mid.ts')!.henryKafura > 0, 'mid: HK > 0')
  console.log('✓ Henry-Kafura = 0 on pure leaves/roots')
}

function testSelfLoopIgnored(): void {
  const nodes = [node('a.ts'), node('b.ts')]
  const edges = [edge('a.ts', 'a.ts'), edge('a.ts', 'b.ts')]
  const m = computeModuleMetrics(nodes, edges)
  const a = m.find((x) => x.file === 'a.ts')!
  assert.equal(a.fanIn, 0, 'self-loop must not contribute to fanIn')
  assert.equal(a.fanOut, 1, 'only the non-self edge a→b counts')
  console.log('✓ self-loops ignored')
}

function testDedupMultiEdges(): void {
  // Si plusieurs edges a→b existent (multi-detector), on dédup au niveau
  // (from, to) pour la centralité.
  const nodes = [node('a.ts'), node('b.ts')]
  const edges = [edge('a.ts', 'b.ts'), edge('a.ts', 'b.ts')]
  const m = computeModuleMetrics(nodes, edges)
  const byFile = new Map(m.map((x) => [x.file, x]))
  assert.equal(byFile.get('b.ts')!.fanIn, 1, 'duplicate pair counted once')
  console.log('✓ multi-edges deduped at (from, to) level')
}

function testDeterminism(): void {
  const nodes = [node('a.ts', 100), node('b.ts', 50), node('c.ts', 200)]
  const edges = [edge('a.ts', 'b.ts'), edge('b.ts', 'c.ts'), edge('a.ts', 'c.ts')]
  const m1 = computeModuleMetrics(nodes, edges)
  const m2 = computeModuleMetrics(nodes, edges)
  assert.equal(JSON.stringify(m1), JSON.stringify(m2))
  console.log('✓ deterministic output')
}

async function run(): Promise<void> {
  testFanInFanOut()
  testEdgeTypeFilter()
  testPageRankHubBeatsLeaf()
  testHenryKafuraFormula()
  testHenryKafuraZeroOnLeafOrRoot()
  testSelfLoopIgnored()
  testDedupMultiEdges()
  testDeterminism()
  console.log('\n  all module-metrics assertions passed')
}

run().catch((err) => {
  console.error('✗ module-metrics test failed:')
  console.error(err)
  process.exit(1)
})
