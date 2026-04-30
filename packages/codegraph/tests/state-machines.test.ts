/**
 * Test d'intégration de l'extracteur state-machines sur fixture.
 *
 * Invariants testés :
 *   1. ApprovalStatus (union) extrait avec 4 états.
 *      - `pending`  : trigger event:approval.submit (via INSERT dans listener).
 *      - `approved` : trigger event:approval.decide.
 *      - `rejected` : trigger event:approval.decide.
 *      - `expired`  : orphan (déclaré, jamais écrit).
 *   2. TaskPhase (enum) extrait avec 3 valeurs.
 *      - `queued`  : trigger route:POST /api/tasks.
 *      - `running` : trigger init (dans constructor).
 *      - `done`    : trigger init (property assignment).
 *   3. `Color` (suffixe non reconnu) n'est PAS émis.
 *   4. Déterminisme octet-équivalent.
 */

import assert from 'node:assert/strict'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createSharedProject } from '../src/extractors/unused-exports.js'
import { analyzeStateMachines } from '../src/extractors/state-machines.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixtureDir = path.resolve(__dirname, 'fixtures/state-machines')

async function run(): Promise<void> {
  const files = (await fs.readdir(fixtureDir))
    .filter((f) => f.endsWith('.ts'))
    .sort()
  const project = createSharedProject(fixtureDir, files, path.join(fixtureDir, 'tsconfig.json'))
  const machines = await analyzeStateMachines(fixtureDir, files, project)

  // ─── 1. ApprovalStatus ──────────────────────────────────────────────

  const approval = machines.find((m) => m.concept === 'ApprovalStatus')
  assert.ok(approval, 'ApprovalStatus not found')
  assert.deepEqual(
    [...approval!.states].sort(),
    ['approved', 'expired', 'pending', 'rejected'],
  )

  // detectionConfidence = 'observed' car des transitions sont vues
  assert.equal(
    approval!.detectionConfidence,
    'observed',
    'ApprovalStatus has transitions → detectionConfidence must be observed',
  )

  // pending : transition avec trigger event:approval.submit
  const pendingT = approval!.transitions.find((t) => t.to === 'pending')
  assert.ok(pendingT, 'pending transition missing')
  assert.equal(pendingT!.trigger.kind, 'event')
  assert.equal(pendingT!.trigger.id, 'approval.submit')

  // approved : trigger event:approval.decide
  const approvedT = approval!.transitions.find((t) => t.to === 'approved')
  assert.ok(approvedT, 'approved transition missing')
  assert.equal(approvedT!.trigger.kind, 'event')
  assert.equal(approvedT!.trigger.id, 'approval.decide')

  const rejectedT = approval!.transitions.find((t) => t.to === 'rejected')
  assert.ok(rejectedT, 'rejected transition missing')
  assert.equal(rejectedT!.trigger.id, 'approval.decide')

  // expired orphan
  assert.deepEqual(approval!.orphanStates, ['expired'])

  // ─── 2. TaskPhase ───────────────────────────────────────────────────

  const task = machines.find((m) => m.concept === 'TaskPhase')
  assert.ok(task, 'TaskPhase not found')
  assert.deepEqual([...task!.states].sort(), ['done', 'queued', 'running'])

  const queued = task!.transitions.find((t) => t.to === 'queued')
  assert.ok(queued, 'queued transition missing')
  assert.equal(queued!.trigger.kind, 'route')
  assert.equal(queued!.trigger.id, 'POST /api/tasks')

  const running = task!.transitions.find((t) => t.to === 'running')
  assert.ok(running, 'running transition missing')
  assert.equal(running!.trigger.kind, 'init')

  const done = task!.transitions.find((t) => t.to === 'done')
  assert.ok(done, 'done transition missing')
  assert.equal(done!.trigger.kind, 'init')

  assert.equal(task!.orphanStates.length, 0, 'TaskPhase should have no orphans')

  // ─── 3. Color absent ────────────────────────────────────────────────

  const color = machines.find((m) => m.concept === 'Color')
  assert.equal(color, undefined, 'Color should not be extracted (no Status/State/Phase/Stage suffix)')

  // ─── 4. WorkerStatus via method-call writes (phase 3.6) ─────────────

  const worker = machines.find((m) => m.concept === 'WorkerStatus')
  assert.ok(worker, 'WorkerStatus not found')
  assert.deepEqual(
    [...worker!.states].sort(),
    ['busy', 'error', 'idle', 'shutdown'],
  )

  // Writes via `this.updateStatus('busy'|'error')` et `this.setStatus('shutdown')`.
  const busyT = worker!.transitions.find((t) => t.to === 'busy')
  assert.ok(busyT, 'busy transition missing — method-call write not detected')
  const errorT = worker!.transitions.find((t) => t.to === 'error')
  assert.ok(errorT, 'error transition missing — method-call write not detected')
  const shutdownT = worker!.transitions.find((t) => t.to === 'shutdown')
  assert.ok(shutdownT, 'shutdown transition missing — `this.setStatus(...)` not detected')

  // `idle` = class-property initializer `private status: WorkerStatus = 'idle'`.
  // Phase 3.6 #1 : scanClassPropertyInitializers → 'idle' est désormais un write
  // init. Aucun orphan pour WorkerStatus.
  assert.deepEqual(worker!.orphanStates, [], 'class property initializer should close `idle`')
  const idleT = worker!.transitions.find((t) => t.to === 'idle')
  assert.ok(idleT, '`idle` class-property init transition missing')
  assert.equal(idleT!.trigger.kind, 'init')

  // ─── 5. DocumentPhase via SQL DEFAULT (phase 3.6 #2) ───────────────

  const doc = machines.find((m) => m.concept === 'DocumentPhase')
  assert.ok(doc, 'DocumentPhase not found')
  assert.deepEqual(
    [...doc!.states].sort(),
    ['archived', 'drafting', 'published', 'reviewing'],
  )
  // Les 2 writes viennent de schema.sql (default 'drafting' et 'reviewing').
  const draftingT = doc!.transitions.find((t) => t.to === 'drafting')
  assert.ok(draftingT, 'drafting SQL-default write not detected')
  assert.equal(draftingT!.trigger.kind, 'init')
  assert.ok(draftingT!.file.endsWith('.sql'), `expected .sql file, got: ${draftingT!.file}`)
  const reviewingT = doc!.transitions.find((t) => t.to === 'reviewing')
  assert.ok(reviewingT, 'reviewing SQL-default write not detected')
  assert.ok(reviewingT!.file.endsWith('.sql'))
  // `published` et `archived` ne sont nulle part écrits → orphans légitimes.
  assert.deepEqual([...doc!.orphanStates].sort(), ['archived', 'published'])
  // `created_at DEFAULT NOW()` ne doit pas produire de write (valeur = fonction).
  assert.ok(
    !doc!.transitions.some((t) => t.to.includes('NOW')),
    'NOW() default should not be captured as a state write',
  )

  // ─── 6. Déterminisme ────────────────────────────────────────────────

  const project2 = createSharedProject(fixtureDir, files, path.join(fixtureDir, 'tsconfig.json'))
  const machines2 = await analyzeStateMachines(fixtureDir, files, project2)
  assert.equal(
    JSON.stringify(machines),
    JSON.stringify(machines2),
    'state-machines not byte-equivalent',
  )

  console.log(`✓ state-machines: ${machines.length} machines`)
  for (const m of machines) {
    const triggers = m.transitions.map((t) => `${t.trigger.kind}:${t.trigger.id || '-'}→${t.to}`).join(', ')
    console.log(`  ${m.concept} [${m.states.join('|')}]  orphans=[${m.orphanStates.join(',')}]  transitions=${triggers}`)
  }
  console.log('  all assertions passed')
}

run().catch((err) => {
  console.error('✗ state-machines test failed:')
  console.error(err)
  process.exit(1)
})
