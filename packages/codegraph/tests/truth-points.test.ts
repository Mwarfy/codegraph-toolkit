/**
 * Test d'intégration de l'extracteur truth-points sur fixture.
 *
 * Invariants testés :
 *   1. Concept `trust_scores` : canonical table, writers (writer.ts), readers
 *      (reader.ts), mirror redis (`trust:...`) avec TTL 30, mirror memory
 *      (`trustCache`), exposed function `getTrustScore` + `listTrustScores`.
 *   2. Concept `approvals` : writers/readers sur approvals, exposed getApproval.
 *      Pas de mirror (pas de redis ou cache matching).
 *   3. `unrelatedStore` (cache sans lien) n'est PAS attribué à trust_scores.
 *   4. Déterminisme octet-équivalent.
 *   5. Tri : concepts avec mirrors d'abord.
 */

import assert from 'node:assert/strict'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createSharedProject } from '../src/detectors/unused-exports.js'
import { analyzeTruthPoints } from '../src/extractors/truth-points.js'
import type { GraphEdge } from '../src/core/types.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixtureDir = path.resolve(__dirname, 'fixtures/truth-points')

async function run(): Promise<void> {
  const files = (await fs.readdir(fixtureDir))
    .filter((f) => f.endsWith('.ts'))
    .sort()
  assert.ok(files.length >= 5)

  const project = createSharedProject(fixtureDir, files, path.join(fixtureDir, 'tsconfig.json'))
  const edges: GraphEdge[] = []  // fixture n'a pas de routes
  const points = await analyzeTruthPoints(fixtureDir, files, project, edges)

  // ─── 1. Concept trust_scores ────────────────────────────────────────

  const trust = points.find((p) => p.concept === 'trust_scores')
  assert.ok(trust, 'trust_scores concept not found')
  assert.equal(trust!.canonical?.kind, 'table')
  assert.equal(trust!.canonical?.name, 'trust_scores')

  // writer.ts = writer ; reader.ts = reader.
  const writerFiles = new Set(trust!.writers.map((w) => w.file))
  assert.ok(writerFiles.has('writer.ts'), 'writer.ts missing from writers')
  const readerFiles = new Set(trust!.readers.map((r) => r.file))
  assert.ok(readerFiles.has('reader.ts'), 'reader.ts missing from readers')
  // Pas de double-comptage : DELETE FROM trust_scores ne doit pas apparaître
  // comme reader (déjà compté comme writer).
  assert.equal(
    trust!.readers.length,
    2,
    `DELETE FROM overlap : expected 2 readers (both from reader.ts SELECTs), got ${trust!.readers.length}`,
  )

  // Writers ont un symbole (persistTrustScore, resetTrust).
  const writerSymbols = trust!.writers.map((w) => w.symbol).filter(Boolean)
  assert.ok(
    writerSymbols.includes('persistTrustScore'),
    `expected persistTrustScore in writers, got ${writerSymbols.join(', ')}`,
  )
  assert.ok(writerSymbols.includes('resetTrust'))

  // Mirror redis détecté avec TTL 30.
  const redisMirror = trust!.mirrors.find((m) => m.kind === 'redis')
  assert.ok(redisMirror, 'redis mirror not found on trust_scores')
  assert.ok(redisMirror!.key.startsWith('trust:'), `unexpected key: ${redisMirror!.key}`)
  assert.equal(redisMirror!.ttl, '30')

  // Mirror memory `trustCache`.
  const memMirror = trust!.mirrors.find((m) => m.kind === 'memory')
  assert.ok(memMirror, 'memory mirror not found')
  assert.equal(memMirror!.key, 'trustCache')
  assert.equal(memMirror!.file, 'cache.ts')

  // `unrelatedStore` ne doit PAS être dans les mirrors de trust_scores.
  const unrelatedOnTrust = trust!.mirrors.find((m) => m.key === 'unrelatedStore')
  assert.equal(unrelatedOnTrust, undefined, 'unrelatedStore leaked into trust_scores mirrors')

  // Exposed functions : getTrustScore + listTrustScores.
  const exposedNames = trust!.exposed.filter((e) => e.kind === 'function').map((e) => e.id)
  assert.ok(exposedNames.includes('getTrustScore'), `expected getTrustScore, got ${exposedNames.join(', ')}`)
  assert.ok(exposedNames.includes('listTrustScores'))

  // ─── 2. Concept approvals ───────────────────────────────────────────

  const approvals = points.find((p) => p.concept === 'approvals')
  assert.ok(approvals, 'approvals concept not found')
  assert.equal(approvals!.mirrors.length, 0, 'approvals should have no mirrors')
  const approvalExposed = approvals!.exposed.filter((e) => e.kind === 'function').map((e) => e.id)
  assert.ok(approvalExposed.includes('getApproval'))
  // createApproval n'a pas le prefix get/find/read/list — pas dans exposed.
  assert.ok(!approvalExposed.includes('createApproval'))

  // ─── 3. Tri : trust_scores avec mirrors d'abord ─────────────────────

  assert.equal(points[0].concept, 'trust_scores', 'trust_scores should be first (has mirrors)')

  // ─── 4. ORM detection (phase 3.6, A.2) ──────────────────────────────

  // Drizzle : `db.insert(reviews).values(...)`, `db.update(reviews)`,
  // `db.delete(reviews)` → 3 writes. `db.select().from(reviews)` + join →
  // 3 reads (2x from reviews, 1x innerJoin sur users).
  const reviews = points.find((p) => p.concept === 'reviews')
  assert.ok(reviews, 'reviews concept (Drizzle) not found')
  assert.ok(reviews!.writers.length >= 3, `Drizzle writes missing (${reviews!.writers.length} writers)`)
  assert.ok(reviews!.readers.length >= 2, `Drizzle reads missing (${reviews!.readers.length} readers)`)
  assert.ok(
    reviews!.writers.some((w) => w.file === 'orm-drizzle.ts' && w.symbol === 'addReview'),
    'addReview writer not found',
  )

  const usersPoint = points.find((p) => p.concept === 'users')
  assert.ok(usersPoint, 'users concept (Drizzle innerJoin) not found')

  // Prisma : `prisma.comment.create/findMany/delete` → 2 writes + 1 read sur `comment`
  // `prisma.post.count()` → 1 read sur `post`
  // `otherClient.foo.findMany()` → NOT detected (client hors whitelist)
  const comment = points.find((p) => p.concept === 'comment')
  assert.ok(comment, 'comment concept (Prisma) not found')
  assert.ok(comment!.writers.length >= 2, `Prisma writes missing (${comment!.writers.length})`)
  assert.ok(comment!.readers.length >= 1, `Prisma reads missing (${comment!.readers.length})`)

  const post = points.find((p) => p.concept === 'post')
  assert.ok(post, 'post concept (Prisma count) not found')
  assert.ok(post!.readers.length >= 1, 'prisma.post.count() read not detected')

  const foo = points.find((p) => p.concept === 'foo')
  assert.equal(foo, undefined, '`otherClient.foo.findMany()` should not produce a concept (client not whitelisted)')

  // ─── 5. Déterminisme ────────────────────────────────────────────────

  const project2 = createSharedProject(fixtureDir, files, path.join(fixtureDir, 'tsconfig.json'))
  const points2 = await analyzeTruthPoints(fixtureDir, files, project2, edges)
  assert.equal(
    JSON.stringify(points),
    JSON.stringify(points2),
    'truth-points output is not byte-equivalent between runs',
  )

  console.log(`✓ truth-points: ${points.length} concepts`)
  for (const p of points) {
    const m = p.mirrors.length
    const w = p.writers.length
    const r = p.readers.length
    const e = p.exposed.length
    console.log(`  ${p.concept}  canonical=${p.canonical?.name ?? '-'}  mirrors=${m} writers=${w} readers=${r} exposed=${e}`)
  }
  console.log('  all assertions passed')
}

run().catch((err) => {
  console.error('✗ truth-points test failed:')
  console.error(err)
  process.exit(1)
})
