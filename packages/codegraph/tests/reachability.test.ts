/**
 * Tests de `findReachablePaths` (phase 3.7 #1).
 */

import assert from 'node:assert/strict'
import { findReachablePaths, globToRegex } from '../src/graph/reachability.js'
import type { GraphEdge } from '../src/core/types.js'

function edge(from: string, to: string, type: GraphEdge['type'] = 'import'): GraphEdge {
  return { id: `${from}->${to}`, from, to, type, resolved: true }
}

function testDirectHopSkipped(): void {
  // Single-hop a → b doit être skippé (path.length < 3).
  const paths = findReachablePaths(
    new Set(['a.ts']),
    new Set(['b.ts']),
    [edge('a.ts', 'b.ts')],
  )
  assert.equal(paths.length, 0, 'direct hop must be skipped (covered by direct `disallow`)')
  console.log('✓ direct single-hop skipped')
}

function testTwoHopDetected(): void {
  // a → mid → b : 2 hops, path length 3, doit être détecté.
  const paths = findReachablePaths(
    new Set(['a.ts']),
    new Set(['b.ts']),
    [edge('a.ts', 'mid.ts'), edge('mid.ts', 'b.ts')],
  )
  assert.equal(paths.length, 1)
  assert.deepEqual(paths[0].path, ['a.ts', 'mid.ts', 'b.ts'])
  console.log('✓ 2-hop transitive path detected')
}

function testShortestPath(): void {
  // Deux chemins existent : a→b→c→d et a→x→d (plus court).
  // BFS retourne le plus court.
  const paths = findReachablePaths(
    new Set(['a.ts']),
    new Set(['d.ts']),
    [
      edge('a.ts', 'b.ts'), edge('b.ts', 'c.ts'), edge('c.ts', 'd.ts'),
      edge('a.ts', 'x.ts'), edge('x.ts', 'd.ts'),
    ],
  )
  assert.equal(paths.length, 1)
  assert.equal(paths[0].path.length, 3, 'BFS must return shortest path (3 nodes, 2 hops)')
  console.log('✓ BFS returns shortest path')
}

function testMultipleSources(): void {
  // a → mid → z et b → mid → z.
  const paths = findReachablePaths(
    new Set(['a.ts', 'b.ts']),
    new Set(['z.ts']),
    [edge('a.ts', 'mid.ts'), edge('b.ts', 'mid.ts'), edge('mid.ts', 'z.ts')],
  )
  assert.equal(paths.length, 2)
  assert.deepEqual(paths.map((p) => p.from).sort(), ['a.ts', 'b.ts'])
  console.log('✓ multiple sources produce per-source paths')
}

function testEdgeTypeFilter(): void {
  // Par défaut on ne suit que `import`. Un cycle event ne crée pas de reach.
  const paths = findReachablePaths(
    new Set(['a.ts']),
    new Set(['b.ts']),
    [edge('a.ts', 'mid.ts', 'event'), edge('mid.ts', 'b.ts', 'event')],
  )
  assert.equal(paths.length, 0, 'event edges must not contribute to reach by default')
  console.log('✓ edge type filter: import only by default')
}

function testGlobToRegex(): void {
  assert.ok(globToRegex('sentinel-core/**').test('sentinel-core/src/kernel.ts'))
  assert.ok(globToRegex('sentinel-core/**').test('sentinel-core/anything'))
  assert.ok(!globToRegex('sentinel-core/**').test('other/foo.ts'))
  assert.ok(globToRegex('**/*.ts').test('a/b/c.ts'))
  assert.ok(globToRegex('a/*/b.ts').test('a/x/b.ts'))
  assert.ok(!globToRegex('a/*/b.ts').test('a/x/y/b.ts'))
  console.log('✓ glob-to-regex matches correctly')
}

function testCycleNoInfiniteLoop(): void {
  // Cycle a → b → a — BFS ne doit pas boucler.
  const paths = findReachablePaths(
    new Set(['a.ts']),
    new Set(['c.ts']),
    [edge('a.ts', 'b.ts'), edge('b.ts', 'a.ts'), edge('b.ts', 'c.ts')],
  )
  assert.equal(paths.length, 1)
  assert.deepEqual(paths[0].path, ['a.ts', 'b.ts', 'c.ts'])
  console.log('✓ cycles handled without infinite loop')
}

function testDeterminism(): void {
  const edges = [
    edge('a.ts', 'm.ts'), edge('a.ts', 'n.ts'),
    edge('m.ts', 'z.ts'), edge('n.ts', 'z.ts'),
  ]
  const p1 = findReachablePaths(new Set(['a.ts']), new Set(['z.ts']), edges)
  const p2 = findReachablePaths(new Set(['a.ts']), new Set(['z.ts']), edges)
  assert.equal(JSON.stringify(p1), JSON.stringify(p2))
  console.log('✓ deterministic output')
}

async function run(): Promise<void> {
  testDirectHopSkipped()
  testTwoHopDetected()
  testShortestPath()
  testMultipleSources()
  testEdgeTypeFilter()
  testGlobToRegex()
  testCycleNoInfiniteLoop()
  testDeterminism()
  console.log('\n  all reachability assertions passed')
}

run().catch((err) => {
  console.error('✗ reachability test failed:')
  console.error(err)
  process.exit(1)
})
