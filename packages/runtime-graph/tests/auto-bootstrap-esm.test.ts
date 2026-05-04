/**
 * Integration test : auto-bootstrap on ESM projects.
 *
 * Spawns a sub-process with `NODE_OPTIONS="--import file://<bootstrap>"`,
 * runs a minimal ESM HTTP app, and asserts that HttpRouteHit captures the
 * 3 routes hit by the app.
 *
 * This is the canary test for the fix landed 2026-05-04 :
 *   - `module.register('import-in-the-middle/hook.mjs', import.meta.url)` to
 *     patch ESM imports of `node:http`, `pg`, `redis`, etc.
 *   - usage via `--import` (not `--require`) so the hook activates BEFORE
 *     any ESM import in the target.
 *
 * Without this : 0 spans captured on any `"type": "module"` project (the
 * silent failure mode that hit Sentinel 2026-05-03 — 3 probe runs, all
 * empty).
 *
 * Test format : black-box subprocess + filesystem assertions. Keeps the
 * test honest — what the test exercises is exactly what production users
 * exercise.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BOOTSTRAP = path.resolve(__dirname, '../dist/capture/auto-bootstrap.js')

let tmpDir: string

const APP_SRC = `
import http from 'node:http'

const server = http.createServer((req, res) => {
  res.statusCode = 200
  res.end('ok')
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const addr = server.address()
const port = typeof addr === 'object' && addr ? addr.port : 0
const base = \`http://127.0.0.1:\${port}\`

async function hit(p) {
  return new Promise((resolve) => {
    http.get(\`\${base}\${p}\`, (res) => {
      res.on('end', resolve)
      res.resume()
    })
  })
}

await hit('/a')
await hit('/b')

await new Promise((r) => setTimeout(r, 100))
server.close()
`

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'rtg-bootstrap-test-'))
  writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'tmp', type: 'module' }))
  writeFileSync(path.join(tmpDir, 'app.mjs'), APP_SRC)
  mkdirSync(path.join(tmpDir, '.codegraph'), { recursive: true })
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('auto-bootstrap — ESM project capture', () => {
  it('captures HTTP route hits via --import', () => {
    if (!existsSync(BOOTSTRAP)) {
      throw new Error(`Bootstrap not built : ${BOOTSTRAP}. Run \`npm run build\` first.`)
    }

    const factsOut = path.join(tmpDir, '.codegraph/facts-runtime')
    const result = spawnSync('node', ['app.mjs'], {
      cwd: tmpDir,
      env: {
        ...process.env,
        NODE_OPTIONS: `--import file://${BOOTSTRAP}`,
        LIBY_RUNTIME_PROJECT_ROOT: tmpDir,
        LIBY_RUNTIME_FACTS_OUT: factsOut,
      },
      encoding: 'utf-8',
    })

    expect(result.status).toBe(0)

    const pidDirs = readdirSync(factsOut).filter((d) => d.startsWith('pid-'))
    expect(pidDirs.length).toBe(1)
    const factsDir = path.join(factsOut, pidDirs[0])

    // Assert RuntimeRunMeta written (always, even on 0 captures)
    const meta = readFileSync(path.join(factsDir, 'RuntimeRunMeta.facts'), 'utf-8')
    expect(meta.split('\n').filter(Boolean)).toHaveLength(1)
    expect(meta).toContain('auto-bootstrap')

    // Assert HttpRouteHit has /a and /b (proves ESM import was patched)
    const http = readFileSync(path.join(factsDir, 'HttpRouteHit.facts'), 'utf-8')
    const lines = http.split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThanOrEqual(2)
    expect(http).toMatch(/\/a/)
    expect(http).toMatch(/\/b/)
  }, 15000)
})
