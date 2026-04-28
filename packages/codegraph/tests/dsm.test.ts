/**
 * Tests du DSM (phase 3.8 #4) — pure arithmétique, pas de fixtures AST.
 */

import assert from 'node:assert/strict'
import { computeDsm } from '../src/graph/dsm.js'
import { renderDsm, aggregateByContainer } from '../src/map/dsm-renderer.js'

function run(): void {
  // ─── 1. Chaîne linéaire a→b→c→d : no cycles, topo stable ────────────
  {
    const nodes = ['a', 'b', 'c', 'd']
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'd' },
    ]
    const dsm = computeDsm(nodes, edges)
    assert.deepEqual(dsm.order, ['a', 'b', 'c', 'd'], 'linear chain: order should be topo')
    assert.equal(dsm.backEdges.length, 0, 'linear chain: no back-edges')
    assert.equal(dsm.levels.length, 4, 'linear chain: 4 singleton levels')
    assert.ok(dsm.levels.every((l) => l.length === 1), 'all levels are singletons')

    // matrix[i][j] = 1 pour chaque edge forward.
    assert.equal(dsm.matrix[0]![1], 1)  // a→b
    assert.equal(dsm.matrix[1]![2], 1)  // b→c
    assert.equal(dsm.matrix[2]![3], 1)  // c→d
    assert.equal(dsm.matrix[3]![0], 0)  // pas de d→a

    console.log('✓ dsm: linear chain — topo order, no back-edges')
  }

  // ─── 2. Cycle simple a ↔ b ─────────────────────────────────────────
  {
    const nodes = ['a', 'b']
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ]
    const dsm = computeDsm(nodes, edges)
    // Tri alpha intra-SCC : a puis b.
    assert.deepEqual(dsm.order, ['a', 'b'])
    assert.equal(dsm.levels.length, 1, 'single SCC of size 2')
    assert.deepEqual(dsm.levels[0], ['a', 'b'])
    assert.equal(dsm.backEdges.length, 1, 'one back-edge for the cycle')
    assert.deepEqual(dsm.backEdges[0], { from: 'b', to: 'a', fromIdx: 1, toIdx: 0 })

    console.log('✓ dsm: simple cycle — 1 SCC of size 2, 1 back-edge')
  }

  // ─── 3. Cas du plan : a→b, b→c, b→d, c→d, c→a ──────────────────────
  //        SCC {a, b, c} (cycle via c→a→b→c), singleton {d}.
  //        Topo sur condensé : SCC_abc puis {d} (car SCC_abc → d).
  //        Ordre émis : a, b, c, d (tri alpha intra-SCC).
  {
    const nodes = ['a', 'b', 'c', 'd']
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'b', to: 'd' },
      { from: 'c', to: 'd' },
      { from: 'c', to: 'a' },
    ]
    const dsm = computeDsm(nodes, edges)
    assert.deepEqual(dsm.order, ['a', 'b', 'c', 'd'], `expected [a,b,c,d], got ${JSON.stringify(dsm.order)}`)
    assert.equal(dsm.levels.length, 2, 'SCC abc + singleton d')
    assert.deepEqual(dsm.levels[0], ['a', 'b', 'c'])
    assert.deepEqual(dsm.levels[1], ['d'])

    // Forward edges : a→b (0,1), b→c (1,2), b→d (1,3), c→d (2,3).
    assert.equal(dsm.matrix[0]![1], 1)
    assert.equal(dsm.matrix[1]![2], 1)
    assert.equal(dsm.matrix[1]![3], 1)
    assert.equal(dsm.matrix[2]![3], 1)

    // Back-edge : c→a (2,0).
    assert.equal(dsm.matrix[2]![0], 1)
    assert.equal(dsm.backEdges.length, 1)
    assert.deepEqual(dsm.backEdges[0], { from: 'c', to: 'a', fromIdx: 2, toIdx: 0 })

    console.log('✓ dsm: plan example — SCC-first topo, c→a is the back-edge')
  }

  // ─── 4. Déterminisme ───────────────────────────────────────────────
  {
    const nodes = ['x', 'y', 'z', 'w']
    const edges = [
      { from: 'y', to: 'x' },
      { from: 'z', to: 'y' },
      { from: 'w', to: 'z' },
    ]
    const d1 = computeDsm(nodes, edges)
    const d2 = computeDsm([...nodes].reverse(), [...edges].reverse())
    assert.equal(JSON.stringify(d1), JSON.stringify(d2), 'dsm non-déterministe entre permutations d\'input')

    console.log('✓ dsm: deterministic across input permutations')
  }

  // ─── 5. Self-loops ignorés ─────────────────────────────────────────
  {
    const dsm = computeDsm(
      ['a', 'b'],
      [{ from: 'a', to: 'a' }, { from: 'a', to: 'b' }],
    )
    assert.equal(dsm.backEdges.length, 0, 'self-loops must not create back-edges')
    assert.equal(dsm.matrix[0]![0], 0, 'diagonal (self-loop) cleared')

    console.log('✓ dsm: self-loops filtered')
  }

  // ─── 6. Agrégation container ───────────────────────────────────────
  {
    const nodes = [
      'sentinel-core/src/kernel/a.ts',
      'sentinel-core/src/kernel/b.ts',
      'sentinel-core/src/packs/c.ts',
      'sentinel-web/src/app/d.ts',
    ]
    const edges = [
      { from: 'sentinel-core/src/kernel/a.ts', to: 'sentinel-core/src/kernel/b.ts' },
      { from: 'sentinel-core/src/kernel/a.ts', to: 'sentinel-core/src/packs/c.ts' },
      { from: 'sentinel-web/src/app/d.ts', to: 'sentinel-core/src/kernel/b.ts' },
    ]
    const agg = aggregateByContainer(nodes, edges, 3)
    assert.deepEqual(agg.nodes.sort(), [
      'sentinel-core/src/kernel',
      'sentinel-core/src/packs',
      'sentinel-web/src/app',
    ])

    // a→b intra-container → skip. a→c cross-container → kept. d→b cross → kept.
    assert.equal(agg.edges.length, 2, 'intra-container edges filtered')

    const dsm = computeDsm(agg.nodes, agg.edges)
    assert.ok(dsm.order.length === 3)

    console.log('✓ dsm: container aggregation (depth=3, intra-container edges dropped)')
  }

  // ─── 7. Rendering — structure minimale ─────────────────────────────
  {
    const dsm = computeDsm(
      ['a', 'b', 'c'],
      [{ from: 'a', to: 'b' }, { from: 'c', to: 'a' }, { from: 'a', to: 'c' }],
    )
    // a→c + c→a → SCC {a, c}, b isolated-ish. Actually a→b is a forward edge
    // too. So SCC {a,c}, singleton {b}. Check:
    // - a→b: 'a' and 'b' — singletons separate
    // - c→a + a→c : cycle → SCC {a,c}
    // Order: {a,c} (SCC comes first since condensed has only one node),
    // then 'b'. Wait: a→b means SCC_ac → b; topo: SCC_ac before b.
    // Final order: a, c, b.
    assert.deepEqual(dsm.order, ['a', 'c', 'b'])

    const md = renderDsm(dsm, { title: 'Test DSM' })
    assert.ok(md.includes('Test DSM'), 'title rendered')
    assert.ok(md.includes('Legend'), 'legend rendered')
    assert.ok(md.includes('Back-edges'), 'back-edges section rendered (1 cycle)')
    assert.ok(md.includes('*cycle*'), 'level with ≥ 2 members marked as cycle')

    console.log('✓ dsm: renderer produces valid markdown with title/legend/back-edges')
  }

  console.log('\n  all dsm assertions passed')
}

try {
  run()
} catch (err) {
  console.error('✗ dsm test failed:')
  console.error(err)
  process.exit(1)
}
