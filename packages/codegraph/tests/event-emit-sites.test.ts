/**
 * Tests for the event-emit-sites extractor.
 *
 * Covers :
 *   1. literal capture (string + template no-substitution)
 *   2. eventConstRef capture (EVENTS.X and PACK_EVENTS.Y)
 *   3. dynamic capture (variable, non-literal init)
 *   4. method-call form (this.emit, bus.emit)
 *   5. negative cases (no object literal, no `type:` prop, foreign callee)
 *   6. determinism between runs
 */

import assert from 'node:assert/strict'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createSharedProject } from '../src/detectors/unused-exports.js'
import { analyzeEventEmitSites } from '../src/extractors/event-emit-sites.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixtureDir = path.resolve(__dirname, 'fixtures/event-emit-sites')

async function run(): Promise<void> {
  const files = (await fs.readdir(fixtureDir)).filter((f) => f.endsWith('.ts')).sort()
  const project = createSharedProject(fixtureDir, files, path.join(fixtureDir, 'tsconfig.json'))
  const sites = await analyzeEventEmitSites(fixtureDir, files, project)

  // ─── 1. literals ──────────────────────────────────────────────────
  const literals = sites.filter((s) => s.kind === 'literal')
  const literalValues = literals.map((s) => s.literalValue).sort()
  assert.deepEqual(
    literalValues,
    ['block.error', 'block.work', 'render.completed'],
    'expected 3 literal emits (1 method-call literal + 2 free)',
  )
  console.log('✓ event-emit-sites: literal kind captured (3 found)')

  // ─── 2. eventConstRef ─────────────────────────────────────────────
  const refs = sites.filter((s) => s.kind === 'eventConstRef')
  const refExpressions = refs.map((s) => s.refExpression).sort()
  assert.deepEqual(
    refExpressions,
    ['EVENTS.BLOCK_ERROR', 'EVENTS.RENDER_COMPLETED', 'VISUAL_EVENTS.STARTED'],
    'expected 3 const refs (kernel EVENTS×2 + pack VISUAL_EVENTS×1)',
  )
  console.log('✓ event-emit-sites: eventConstRef kind captured (3 found)')

  // ─── 3. dynamic ───────────────────────────────────────────────────
  const dynamics = sites.filter((s) => s.kind === 'dynamic')
  assert.equal(dynamics.length, 1, 'expected 1 dynamic emit (variable arg)')
  assert.ok(dynamics[0].file.endsWith('sample.ts'))
  console.log('✓ event-emit-sites: dynamic kind captured (1 found)')

  // ─── 4. method-call form ──────────────────────────────────────────
  const methodCalls = sites.filter((s) => s.isMethodCall)
  // this.emit({ type: 'block.work' }) + bus.emit({ type: EVENTS.BLOCK_ERROR })
  assert.equal(methodCalls.length, 2, 'expected 2 method-call emits')
  const receivers = methodCalls.map((s) => s.receiver).sort()
  assert.deepEqual(receivers, ['bus', 'this'])
  console.log('✓ event-emit-sites: method-call form captured (this.emit, bus.emit)')

  // ─── 5. negatives ─────────────────────────────────────────────────
  // notCaptured1 : emit(payload) — no object literal
  // notCaptured2 : { kind: ... } — wrong prop name
  // notCaptured3 : send(...) — wrong callee
  // Total expected sites: 3 literals + 3 refs + 1 dynamic = 7.
  assert.equal(sites.length, 7, `unexpected total: ${sites.length} (should be 7)`)
  console.log('✓ event-emit-sites: negatives correctly skipped (total = 7)')

  // ─── 6. determinism ───────────────────────────────────────────────
  const project2 = createSharedProject(fixtureDir, files, path.join(fixtureDir, 'tsconfig.json'))
  const sites2 = await analyzeEventEmitSites(fixtureDir, files, project2)
  assert.equal(
    JSON.stringify(sites),
    JSON.stringify(sites2),
    'event-emit-sites output not byte-equivalent between runs',
  )
  console.log('✓ event-emit-sites: deterministic across runs')

  // ─── 7. callee names ──────────────────────────────────────────────
  const calleeNames = new Set(sites.map((s) => s.callee))
  // emit + emitEvent are both expected
  assert.ok(calleeNames.has('emit'), 'emit not seen')
  assert.ok(calleeNames.has('emitEvent'), 'emitEvent not seen')
  console.log('✓ event-emit-sites: emit + emitEvent both matched')

  console.log(`\n  ${sites.length} sites total — all assertions passed`)
}

run().catch((err) => {
  console.error('✗ event-emit-sites test failed:')
  console.error(err)
  process.exit(1)
})
