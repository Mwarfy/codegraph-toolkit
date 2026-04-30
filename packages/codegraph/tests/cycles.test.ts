/**
 * Test d'intégration de l'extracteur cycles sur fixture.
 *
 * Edges synthétiques (pas d'imports réels dans les fichiers — on isole
 * l'algorithme Tarjan + gate detection de la sortie du détecteur ts-imports).
 *
 * Invariants testés :
 *   1. 3 cycles détectés (a↔b, c→d→e→c, x↔y).
 *   2. standalone.ts n'apparaît dans aucun cycle.
 *   3. Cycle c→d→e→c marqué `gated: true`, avec `isAllowed` dans d.ts détecté.
 *   4. Cycles a↔b et x↔y marqués `gated: false`.
 *   5. Ordre de sortie : non-gated d'abord, puis gated, stable.
 *   6. Déterminisme : deux runs identiques → sorties JSON octet-équivalentes.
 *   7. Self-loops ignorés.
 */

import assert from 'node:assert/strict'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createSharedProject } from '../src/extractors/unused-exports.js'
import { analyzeCycles } from '../src/extractors/cycles.js'
import type { GraphEdge } from '../src/core/types.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixtureDir = path.resolve(__dirname, 'fixtures/cycles')

function makeEdge(from: string, to: string, type: GraphEdge['type'], label?: string, line = 1): GraphEdge {
  return {
    id: `${from}--${type}--${to}`,
    from,
    to,
    type,
    resolved: true,
    line,
    ...(label ? { label } : {}),
  }
}

async function run(): Promise<void> {
  const files = (await fs.readdir(fixtureDir))
    .filter((f) => f.endsWith('.ts'))
    .sort()

  assert.ok(files.includes('a.ts'))
  assert.ok(files.includes('d.ts'))
  assert.ok(files.includes('standalone.ts'))

  const tsConfigPath = path.join(fixtureDir, 'tsconfig.json')
  const project = createSharedProject(fixtureDir, files, tsConfigPath)

  // Edges synthétiques : trois cycles distincts + un self-loop + un
  // standalone qu'on ne référence pas pour confirmer qu'il est ignoré.
  const edges: GraphEdge[] = [
    // Cycle 1 : a ↔ b (imports)
    makeEdge('a.ts', 'b.ts', 'import'),
    makeEdge('b.ts', 'a.ts', 'import'),
    // Cycle 2 : c → d → e → c (imports)
    makeEdge('c.ts', 'd.ts', 'import'),
    makeEdge('d.ts', 'e.ts', 'import'),
    makeEdge('e.ts', 'c.ts', 'import'),
    // Cycle 3 : x ↔ y via events
    makeEdge('x.ts', 'y.ts', 'event', 'started'),
    makeEdge('y.ts', 'x.ts', 'event', 'ack'),
    // Self-loop : ne doit PAS produire un cycle.
    makeEdge('standalone.ts', 'standalone.ts', 'import'),
    // Edge db-table : ignorée par default (pas dans edgeTypes).
    makeEdge('a.ts', 'standalone.ts', 'db-table'),
    makeEdge('standalone.ts', 'a.ts', 'db-table'),
  ]

  const cycles = await analyzeCycles(fixtureDir, files, edges, project)

  // ─── 1. Count ──────────────────────────────────────────────────────
  assert.equal(cycles.length, 3, `expected 3 cycles, got ${cycles.length}`)

  // ─── 2. standalone.ts absent ────────────────────────────────────────
  for (const c of cycles) {
    assert.ok(!c.nodes.includes('standalone.ts'), 'standalone.ts must not be in any cycle')
  }

  // ─── 3. Cycle c-d-e gated ──────────────────────────────────────────
  const cdeCycle = cycles.find((c) => c.nodes.includes('c.ts') && c.nodes.includes('d.ts'))
  assert.ok(cdeCycle, 'c-d-e cycle not found')
  assert.equal(cdeCycle!.gated, true, 'c-d-e should be gated')
  assert.ok(cdeCycle!.gates.length >= 1, 'at least 1 gate expected')
  const dGate = cdeCycle!.gates.find((g) => g.file === 'd.ts')
  assert.ok(dGate, 'gate in d.ts not found')
  assert.equal(dGate!.symbol, 'isAllowed')

  // ─── 4. Cycle a-b, x-y non-gated ────────────────────────────────────
  const abCycle = cycles.find((c) => c.nodes.includes('a.ts') && c.nodes.includes('b.ts'))
  assert.ok(abCycle, 'a-b cycle not found')
  assert.equal(abCycle!.gated, false)
  assert.equal(abCycle!.gates.length, 0)

  const xyCycle = cycles.find((c) => c.nodes.includes('x.ts') && c.nodes.includes('y.ts'))
  assert.ok(xyCycle, 'x-y cycle not found')
  assert.equal(xyCycle!.gated, false)
  // Event edges : le représentant doit être event, pas import.
  assert.equal(xyCycle!.edges[0].type, 'event')
  assert.ok(['started', 'ack'].includes(xyCycle!.edges[0].label ?? ''))

  // ─── 5. Ordre : non-gated d'abord ───────────────────────────────────
  assert.equal(cycles[0].gated, false)
  assert.equal(cycles[cycles.length - 1].gated, true)

  // ─── 6. Déterminisme ────────────────────────────────────────────────
  const project2 = createSharedProject(fixtureDir, files, tsConfigPath)
  const cycles2 = await analyzeCycles(fixtureDir, files, edges, project2)
  assert.equal(
    JSON.stringify(cycles),
    JSON.stringify(cycles2),
    'cycles output is not byte-equivalent between runs',
  )

  // ─── 7. Invariants de forme ────────────────────────────────────────
  for (const c of cycles) {
    assert.equal(c.nodes[0], c.nodes[c.nodes.length - 1], 'path must start == end')
    assert.equal(c.size, c.nodes.length - 1)
    assert.ok(c.sccSize >= c.size)
    assert.equal(c.edges.length, c.nodes.length - 1, 'one edge per step of path')
  }

  console.log(`✓ cycles: ${cycles.length} cycles`)
  for (const c of cycles) {
    const gateStr = c.gated ? `gated[${c.gates.map((g) => `${g.file}:${g.symbol}`).join(',')}]` : 'non-gated'
    console.log(`  ${c.nodes.join(' → ')} (${gateStr})`)
  }
  console.log('  all assertions passed')
}

run().catch((err) => {
  console.error('✗ cycles test failed:')
  console.error(err)
  process.exit(1)
})
