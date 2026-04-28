/**
 * Tests du taint analyzer (phase 3.8 #3).
 */

import assert from 'node:assert/strict'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createSharedProject } from '../src/detectors/unused-exports.js'
import { analyzeTaint } from '../src/extractors/taint.js'
import type { TaintRules } from '../src/core/types.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixtureDir = path.resolve(__dirname, 'fixtures/taint')

async function loadRules(): Promise<TaintRules> {
  const p = path.resolve(__dirname, '..', 'taint-rules.json')
  const raw = JSON.parse(await fs.readFile(p, 'utf-8'))
  return {
    sources: raw.sources,
    sinks: raw.sinks,
    sanitizers: raw.sanitizers,
  }
}

async function run(): Promise<void> {
  const files = (await fs.readdir(fixtureDir))
    .filter((f) => f.endsWith('.ts'))
    .sort()
  const project = createSharedProject(fixtureDir, files, path.join(fixtureDir, 'tsconfig.json'))
  const rules = await loadRules()
  const violations = await analyzeTaint(fixtureDir, files, project, rules)

  // Indexer violations par fichier.
  const byFile = new Map<string, typeof violations>()
  for (const v of violations) {
    const arr = byFile.get(v.file) ?? []
    arr.push(v)
    byFile.set(v.file, arr)
  }

  function expect(file: string, min: number, max: number = min, msg: string): void {
    const n = byFile.get(file)?.length ?? 0
    assert.ok(n >= min && n <= max, `${file}: expected ${min}${min !== max ? `..${max}` : ''} violations, got ${n}. ${msg}`)
  }

  // ─── 1. Direct source → sink ────────────────────────────────────────
  expect('01-direct-vuln.ts', 1, 1, 'eval(req.body) direct')
  const v1 = byFile.get('01-direct-vuln.ts')![0]
  assert.equal(v1.sourceName, 'http-body')
  assert.equal(v1.sinkName, 'eval')
  assert.equal(v1.severity, 'critical')
  assert.equal(v1.symbol, 'vuln1')
  assert.equal(v1.chain.length, 2)
  assert.equal(v1.chain[0].kind, 'source')
  assert.equal(v1.chain[1].kind, 'sink')
  console.log('✓ taint: direct source → sink (fixture 01)')

  // ─── 2. Via variable intermédiaire ──────────────────────────────────
  expect('02-intermediate-var.ts', 1, 1, 'x = req.body; eval(x)')
  const v2 = byFile.get('02-intermediate-var.ts')![0]
  assert.equal(v2.sourceName, 'http-body')
  assert.equal(v2.sinkName, 'eval')
  console.log('✓ taint: aliasing (fixture 02)')

  // ─── 3. Sanitizer cuts taint ────────────────────────────────────────
  expect('03-sanitized.ts', 0, 0, 'validateBody washes taint')
  console.log('✓ taint: validateBody sanitizes (fixture 03)')

  // ─── 4. No source, no violation ─────────────────────────────────────
  expect('04-clean.ts', 0, 0, 'literal only')
  console.log('✓ taint: pure literal clean (fixture 04)')

  // ─── 5. Passthrough fn propagates ──────────────────────────────────
  expect('05-passthrough-fn.ts', 1, 1, 'derive() is not a sanitizer → taint persists')
  const v5 = byFile.get('05-passthrough-fn.ts')![0]
  assert.equal(v5.sourceName, 'http-body')
  console.log('✓ taint: passthrough fn propagates (fixture 05)')

  // ─── 6. Property chain from tainted root ────────────────────────────
  expect('06-property-chain.ts', 1, 1, 'body.cmd → tainted via root')
  const v6 = byFile.get('06-property-chain.ts')![0]
  assert.equal(v6.sinkName, 'exec-sync')
  console.log('✓ taint: property chain root propagation (fixture 06)')

  // ─── 7. Method sink + template literal ─────────────────────────────
  expect('07-method-sink.ts', 1, 1, 'db.query(`... ${id}`) with id tainted')
  const v7 = byFile.get('07-method-sink.ts')![0]
  assert.equal(v7.sinkName, 'sql-query')
  assert.equal(v7.sourceName, 'http-params')
  console.log('✓ taint: method-call sink + template literal (fixture 07)')

  // ─── 8. Reassign to clean cuts taint ────────────────────────────────
  expect('08-reassign-clean.ts', 0, 0, 'x reassigned to literal before sink')
  console.log('✓ taint: clean reassignment drops taint (fixture 08)')

  // ─── 9. Déterminisme ───────────────────────────────────────────────
  const project2 = createSharedProject(fixtureDir, files, path.join(fixtureDir, 'tsconfig.json'))
  const violations2 = await analyzeTaint(fixtureDir, files, project2, rules)
  assert.equal(
    JSON.stringify(violations),
    JSON.stringify(violations2),
    'taint output non-déterministe entre runs',
  )
  console.log('✓ taint: deterministic across runs')

  console.log(`\n  Summary: ${violations.length} violations across ${byFile.size} files\n  all taint assertions passed`)
}

run().catch((err) => {
  console.error('✗ taint test failed:')
  console.error(err)
  process.exit(1)
})
