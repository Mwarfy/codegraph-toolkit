/**
 * Test d'intégration de l'extracteur data-flows sur fixture.
 *
 * Invariants testés :
 *   1. Entry HTTP `POST /api/approvals/resolve` détecté, handler =
 *      `server.ts:handleApprovalRoutes`, inputType issu de la signature.
 *   2. Steps BFS : handler → resolveApproval (via typedCalls).
 *   3. Sinks : db-write sur `approvals`, event-emit `approval.resolved`,
 *      http-response.
 *   4. Entry `event:approval.resolved` détecté sur auditApproval.
 *   5. Downstream : le flow HTTP contient en downstream le flow du
 *      listener (qui a un sink db-write sur decision_journal).
 *   6. Déterminisme octet-équivalent.
 */

import assert from 'node:assert/strict'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createSharedProject } from '../src/extractors/unused-exports.js'
import { analyzeTypedCalls } from '../src/extractors/typed-calls.js'
import { analyzeDataFlows } from '../src/extractors/data-flows.js'
import type { GraphEdge } from '../src/core/types.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixtureDir = path.resolve(__dirname, 'fixtures/data-flows')

async function run(): Promise<void> {
  const files = (await fs.readdir(fixtureDir))
    .filter((f) => f.endsWith('.ts'))
    .sort()
  const project = createSharedProject(fixtureDir, files, path.join(fixtureDir, 'tsconfig.json'))
  const typedCalls = await analyzeTypedCalls(fixtureDir, files, project)
  const edges: GraphEdge[] = []
  const flows = await analyzeDataFlows(fixtureDir, files, project, typedCalls, edges)

  // ─── 1. Entry HTTP ──────────────────────────────────────────────────

  const httpFlow = flows.find((f) => f.entry.kind === 'http-route' && f.entry.id === 'POST /api/approvals/resolve')
  assert.ok(httpFlow, `POST /api/approvals/resolve not found. Got: ${flows.map((f) => f.entry.id).join(', ')}`)
  assert.equal(httpFlow!.entry.file, 'server.ts')
  assert.equal(httpFlow!.entry.handler, 'server.ts:handleApprovalRoutes')
  assert.ok(httpFlow!.inputType?.includes('Req') || httpFlow!.inputType === 'Req', `inputType: ${httpFlow!.inputType}`)

  // ─── 2. Steps BFS ───────────────────────────────────────────────────

  const stepNodes = httpFlow!.steps.map((s) => s.node)
  assert.ok(
    stepNodes.includes('server.ts:handleApprovalRoutes'),
    `handler missing from steps: ${stepNodes.join(', ')}`,
  )
  assert.ok(
    stepNodes.includes('approval-service.ts:resolveApproval'),
    `resolveApproval missing from steps: ${stepNodes.join(', ')}`,
  )

  // ─── 3. Sinks ───────────────────────────────────────────────────────

  const sinkKinds = new Set(httpFlow!.sinks.map((s) => s.kind))
  assert.ok(sinkKinds.has('db-write'), `db-write missing. sinks: ${JSON.stringify(httpFlow!.sinks)}`)
  assert.ok(sinkKinds.has('event-emit'))
  assert.ok(sinkKinds.has('http-response'))

  const dbSink = httpFlow!.sinks.find((s) => s.kind === 'db-write')!
  assert.equal(dbSink.target, 'approvals')
  const emitSink = httpFlow!.sinks.find((s) => s.kind === 'event-emit')!
  assert.equal(emitSink.target, 'approval.resolved')

  // ─── 4. Entry event-listener ────────────────────────────────────────

  const listenerFlow = flows.find(
    (f) => f.entry.kind === 'event-listener' && f.entry.id === 'event:approval.resolved',
  )
  assert.ok(listenerFlow, 'event-listener flow for approval.resolved not found')
  // Handler résolu à auditApproval nommé.
  assert.ok(listenerFlow!.entry.handler?.includes('auditApproval'), `handler: ${listenerFlow!.entry.handler}`)

  // listener devrait avoir un db-write sur decision_journal.
  const listenerDbSink = listenerFlow!.sinks.find((s) => s.kind === 'db-write')
  assert.ok(listenerDbSink, `listener sinks: ${JSON.stringify(listenerFlow!.sinks)}`)
  assert.equal(listenerDbSink!.target, 'decision_journal')

  // ─── 5. Downstream ──────────────────────────────────────────────────

  assert.ok(
    httpFlow!.downstream && httpFlow!.downstream.length >= 1,
    `downstream attendu sur POST /api/approvals/resolve. Got: ${JSON.stringify(httpFlow!.downstream)}`,
  )
  const downEntry = httpFlow!.downstream![0].entry
  assert.equal(downEntry.id, 'event:approval.resolved')

  // ─── 6. Interval + BullMQ Worker + HTTP outbound (phase 3.6) ────────

  const intervalFlows = flows.filter((f) => f.entry.kind === 'interval')
  assert.ok(intervalFlows.length >= 2, `expected ≥2 interval entries, got ${intervalFlows.length}`)

  const pollFlow = intervalFlows.find((f) => f.entry.handler === 'scheduler.ts:pollMetrics')
  assert.ok(pollFlow, 'setInterval(pollMetrics, ...) entry not detected')
  // pollMetrics contient un db.query → doit produire un db-write sink ? Non —
  // c'est un SELECT, pas un INSERT. Juste vérifier que le flow existe.

  const bullmqFlows = flows.filter((f) => f.entry.kind === 'bullmq-job')
  assert.equal(bullmqFlows.length, 1, `expected 1 BullMQ worker, got ${bullmqFlows.length}`)
  assert.equal(bullmqFlows[0].entry.id, 'queue:email-queue')
  assert.equal(bullmqFlows[0].entry.handler, 'scheduler.ts:processEmail')
  // processEmail fait un fetch outbound → sink http-outbound sur api.sendgrid.com
  const outboundSink = bullmqFlows[0].sinks.find((s) => s.kind === 'http-outbound')
  assert.ok(outboundSink, `email worker should have http-outbound sink, got: ${bullmqFlows[0].sinks.map((s) => s.kind).join(',')}`)
  assert.equal(outboundSink!.target, 'api.sendgrid.com')

  // callYoutube via axios.get/post → 2 outbound sinks sur googleapis.com
  // (visibles via la fonction container `callYoutube`, pas via un entry-point).
  // On cherche les sinks par container sur les flows existants OU on s'assure
  // qu'ils apparaissent quelque part.
  const allSinks = flows.flatMap((f) => f.sinks)
  const googleapisSinks = allSinks.filter(
    (s) => s.kind === 'http-outbound' && s.target === 'www.googleapis.com',
  )
  // callYoutube n'est entry-point d'aucun flow — ses sinks ne sont pas attachés
  // à un entry. C'est une limite attendue v1 (les sinks sans entry n'apparaissent
  // pas dans les flows). Le test pin juste que le sink outbound MARCHE quand
  // attaché à un entry (cas BullMQ processEmail).
  void googleapisSinks

  // Relative URL + dynamic URL dans scheduler.ts NE DOIT PAS polluer les sinks
  // d'autres flows (car pas d'entry-point les atteint). Mais si localFetch ou
  // dynamicFetch étaient attrapés par BFS depuis un entry, on verrait des sinks
  // avec target='<dynamic>' ou skippé. Pas de flow les touche → rien à vérifier.

  // ─── 7. Déterminisme ────────────────────────────────────────────────

  const project2 = createSharedProject(fixtureDir, files, path.join(fixtureDir, 'tsconfig.json'))
  const typedCalls2 = await analyzeTypedCalls(fixtureDir, files, project2)
  const flows2 = await analyzeDataFlows(fixtureDir, files, project2, typedCalls2, edges)
  assert.equal(
    JSON.stringify(flows),
    JSON.stringify(flows2),
    'data-flows output not byte-equivalent',
  )

  console.log(`✓ data-flows: ${flows.length} flows`)
  for (const f of flows) {
    const sinkSummary = f.sinks.map((s) => `${s.kind}:${s.target || '-'}`).join(',')
    const dsLen = f.downstream?.length ?? 0
    console.log(`  [${f.entry.kind}] ${f.entry.id}  steps=${f.steps.length} sinks=[${sinkSummary}] downstream=${dsLen}`)
  }
  console.log('  all assertions passed')
}

run().catch((err) => {
  console.error('✗ data-flows test failed:')
  console.error(err)
  process.exit(1)
})
