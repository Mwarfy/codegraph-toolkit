/**
 * Tests de l'extracteur env-usage (phase 3.6 B.5).
 */

import assert from 'node:assert/strict'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createSharedProject } from '../src/extractors/unused-exports.js'
import { analyzeEnvUsage } from '../src/extractors/env-usage.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixtureDir = path.resolve(__dirname, 'fixtures/env-usage')

async function run(): Promise<void> {
  const files = (await fs.readdir(fixtureDir)).filter((f) => f.endsWith('.ts')).sort()
  const project = createSharedProject(fixtureDir, files, path.join(fixtureDir, 'tsconfig.json'))
  const usage = await analyzeEnvUsage(fixtureDir, files, project)

  // ─── 1. Noms capturés ─────────────────────────────────────────────
  const names = new Set(usage.map((u) => u.name))
  assert.ok(names.has('DATABASE_URL'), 'DATABASE_URL not captured')
  assert.ok(names.has('OPENAI_API_KEY'), 'OPENAI_API_KEY not captured (ElementAccess)')
  assert.ok(names.has('PORT'))
  assert.ok(names.has('NODE_ENV'))
  assert.ok(names.has('SECRET_TOKEN'))

  // Accès dynamique `process.env[name]` ne doit PAS apparaître.
  assert.ok(!names.has('name'), 'dynamic access leaked')

  // `process.env.toString` ne matche pas le pattern `[A-Z_]+` → skip.
  assert.ok(!names.has('toString'))
  assert.ok(!names.has('TOSTRING'))

  console.log('✓ env-usage: names captured correctly')

  // ─── 2. Multiple readers ──────────────────────────────────────────
  const secret = usage.find((u) => u.name === 'SECRET_TOKEN')
  assert.ok(secret)
  assert.equal(secret!.readers.length, 2, 'SECRET_TOKEN should have 2 readers (readSecret + readSecretAgain)')
  const symbols = secret!.readers.map((r) => r.symbol).sort()
  assert.deepEqual(symbols, ['readSecret', 'readSecretAgain'])

  console.log('✓ env-usage: multiple readers aggregated')

  // ─── 3. hasDefault detection ──────────────────────────────────────
  const port = usage.find((u) => u.name === 'PORT')
  assert.ok(port)
  assert.equal(port!.readers[0].hasDefault, true, 'PORT has `?? "3000"` → hasDefault=true')

  const nodeEnv = usage.find((u) => u.name === 'NODE_ENV')
  assert.ok(nodeEnv)
  assert.equal(nodeEnv!.readers[0].hasDefault, true, 'NODE_ENV has `|| "development"` → hasDefault=true')

  const dbUrl = usage.find((u) => u.name === 'DATABASE_URL')
  assert.ok(dbUrl)
  assert.equal(dbUrl!.readers[0].hasDefault, false, 'DATABASE_URL has no default')

  console.log('✓ env-usage: hasDefault detected via ?? and ||')

  // ─── 4. isSecret heuristic ────────────────────────────────────────
  assert.equal(secret!.isSecret, true, 'SECRET_TOKEN contains "SECRET" → isSecret')
  const apikey = usage.find((u) => u.name === 'OPENAI_API_KEY')
  assert.ok(apikey)
  assert.equal(apikey!.isSecret, true, 'OPENAI_API_KEY contains "KEY" → isSecret')
  assert.equal(port!.isSecret, false, 'PORT is not secret')
  assert.equal(nodeEnv!.isSecret, false, 'NODE_ENV is not secret')

  console.log('✓ env-usage: isSecret heuristic correct')

  // ─── 4b. wrappedIn detection (ADR-019 prep) ────────────────────────
  const healer = usage.find((u) => u.name === 'HEALER_CYCLE_MS')
  assert.ok(healer)
  assert.equal(healer!.readers[0].wrappedIn, 'parseInt',
    'HEALER_CYCLE_MS read is wrapped in parseInt(... ?? ..., 10)')

  const retention = usage.find((u) => u.name === 'RETENTION_DAYS')
  assert.ok(retention)
  assert.equal(retention!.readers[0].wrappedIn, 'parseFloat',
    'RETENTION_DAYS wrapped in parseFloat')

  const maxBudget = usage.find((u) => u.name === 'MAX_BUDGET')
  assert.ok(maxBudget)
  assert.equal(maxBudget!.readers[0].wrappedIn, 'Number',
    'MAX_BUDGET wrapped in Number(...)')

  const coerced = usage.find((u) => u.name === 'COERCED_VAL')
  assert.ok(coerced)
  assert.equal(coerced!.readers[0].wrappedIn, 'coerce',
    'method-call wrapping captured (rightmost identifier)')

  const raw = usage.find((u) => u.name === 'RAW_ENV')
  assert.ok(raw)
  assert.equal(raw!.readers[0].wrappedIn, undefined,
    'no wrapping when read is bare')

  // dbUrl is the same case (bare assignment) — confirm.
  assert.equal(dbUrl!.readers[0].wrappedIn, undefined)

  console.log('✓ env-usage: wrappedIn detected (parseInt, parseFloat, Number, method-call)')

  // ─── 5. Tri stable + déterminisme ──────────────────────────────────
  const project2 = createSharedProject(fixtureDir, files, path.join(fixtureDir, 'tsconfig.json'))
  const usage2 = await analyzeEnvUsage(fixtureDir, files, project2)
  assert.equal(
    JSON.stringify(usage),
    JSON.stringify(usage2),
    'env-usage output not byte-equivalent between runs',
  )

  console.log(`✓ env-usage: ${usage.length} vars captured`)
  for (const u of usage) {
    const noDefault = u.readers.filter((r) => !r.hasDefault).length
    console.log(`  ${u.isSecret ? '🔒 ' : '   '}${u.name} readers=${u.readers.length} no-default=${noDefault}`)
  }
  console.log('  all assertions passed')
}

run().catch((err) => {
  console.error('✗ env-usage test failed:')
  console.error(err)
  process.exit(1)
})
