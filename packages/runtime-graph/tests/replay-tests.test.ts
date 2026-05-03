/**
 * replay-tests driver E2E test.
 *
 * Stratégie : crée un mini-projet temporaire avec un test minimal qui
 * exerce du code observable, lance replayTestsDriver dessus, vérifie
 * que les facts produits par auto-bootstrap.ts existent et contiennent
 * des spans capturés.
 *
 * Ce test exerce le path complet : spawn sub-process avec NODE_OPTIONS,
 * bootstrap attache OTel, sub-process exit → flush facts → tmpDir.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import { replayTestsDriver } from '../src/drivers/replay-tests.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const TOOLKIT_ROOT = path.resolve(__dirname, '../../..')
const RUNTIME_GRAPH_DIST = path.resolve(__dirname, '../dist')

let projectDir: string

beforeAll(async () => {
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rg-replay-test-'))

  // Mini projet : 1 fichier app.js qui produit un span manuel,
  // 1 script "test" dans package.json qui run app.js (suffit comme
  // "suite de tests" pour valider que le bootstrap capture).
  await fs.writeFile(path.join(projectDir, 'package.json'), JSON.stringify({
    name: 'replay-test-mini',
    version: '0.0.0',
    type: 'module',
    scripts: { test: `node ${path.join(projectDir, 'app.js')}` },
  }, null, 2))

  // app.js : importe runtime-graph helper, fait un span manuel.
  // Le bootstrap (via NODE_OPTIONS) attache déjà OTel — on accède
  // au tracerProvider via getActiveCapture().
  // Le bootstrap est résolu via path absolu (lib non-installée dans tmp).
  const bootstrapAbs = path.join(RUNTIME_GRAPH_DIST, 'capture/auto-bootstrap.js')
  const otelAttachAbs = path.join(RUNTIME_GRAPH_DIST, 'capture/otel-attach.js')

  await fs.writeFile(path.join(projectDir, 'app.js'), `
    import { getActiveCapture } from '${otelAttachAbs}'
    const { tracerProvider } = getActiveCapture()
    const tracer = tracerProvider.getTracer('replay-test-mini')
    await tracer.startActiveSpan('mini-task', async (span) => {
      span.setAttribute('code.filepath', '${path.join(projectDir, 'app.js')}')
      span.setAttribute('code.function', 'doMiniTask')
      // Simulate work
      await new Promise(r => setTimeout(r, 10))
      span.end()
    })
  `)

  // Préfixe le bootstrap dans NODE_OPTIONS via env du driver — le driver
  // utilise resolveBootstrapPath() qui essaye plusieurs paths. On override
  // en plaçant un node_modules/@liby-tools/runtime-graph symlink-ish.
  const linkDir = path.join(projectDir, 'node_modules/@liby-tools/runtime-graph')
  await fs.mkdir(linkDir, { recursive: true })
  // Symlink dist for resolveBootstrapPath
  await fs.symlink(RUNTIME_GRAPH_DIST, path.join(linkDir, 'dist'), 'dir').catch(async () => {
    // Fallback : copy si symlink fail (Windows). Pour Phase β on testera Win.
    await fs.cp(RUNTIME_GRAPH_DIST, path.join(linkDir, 'dist'), { recursive: true })
  })
  // Aussi copy le package.json minimal pour que le require soit valide
  await fs.writeFile(path.join(linkDir, 'package.json'), JSON.stringify({
    name: '@liby-tools/runtime-graph',
    version: '0.1.0-alpha.1',
    main: './dist/index.js',
  }))
})

afterAll(async () => {
  if (projectDir) await fs.rm(projectDir, { recursive: true, force: true })
})

describe('replay-tests driver E2E', () => {
  it('spawns sub-process with auto-bootstrap, captures spans, exposes bootstrapFactsDir', async () => {
    const result = await replayTestsDriver.run({
      projectRoot: projectDir,
      durationMs: 30_000,
      config: {
        command: 'npm',
        args: ['test'],
        continueOnTestFailure: true,
        // Disable auto-instruments dans le sub-process : on capture seulement
        // notre span manuel (pas le bruit HTTP/DB du runner Node).
        enableAutoInstruments: false,
      },
    })

    // The driver should have completed and exposed a bootstrapFactsDir
    expect(result.bootstrapFactsDir, 'driver exposes bootstrapFactsDir').toBeDefined()
    expect(result.bootstrapFactsDir!).toContain('rg-replay-')

    // Le bootstrap écrit dans des sub-dirs pid-<N>/ pour éviter les
    // collisions parent/child (cf. bug npm test parent qui écrasait child).
    // Donc on liste les sub-dirs et on cherche celui qui a notre span manuel.
    const entries = await fs.readdir(result.bootstrapFactsDir!, { withFileTypes: true })
    const pidDirs = entries.filter(e => e.isDirectory() && e.name.startsWith('pid-'))
    expect(pidDirs.length, 'at least 1 pid-* sub-dir').toBeGreaterThan(0)

    // Cherche le sub-dir qui contient notre span 'doMiniTask'
    let foundChildDir: string | null = null
    let totalSpansChild = 0
    for (const d of pidDirs) {
      const symFile = path.join(result.bootstrapFactsDir!, d.name, 'SymbolTouchedRuntime.facts')
      try {
        const content = await fs.readFile(symFile, 'utf-8')
        if (content.includes('doMiniTask')) {
          foundChildDir = path.join(result.bootstrapFactsDir!, d.name)
          // Read meta from same pid-dir
          const metaContent = await fs.readFile(path.join(foundChildDir, 'RuntimeRunMeta.facts'), 'utf-8')
          const cols = metaContent.trim().split('\n')[0].split('\t')
          expect(cols[0]).toBe('auto-bootstrap')
          totalSpansChild = parseInt(cols[3], 10)
          break
        }
      } catch { /* skip */ }
    }
    expect(foundChildDir, 'sub-process pid-dir with doMiniTask span').not.toBeNull()
    expect(totalSpansChild, 'child captured >= 1 span').toBeGreaterThan(0)

    // actionsCount = somme des totalSpans de tous les pid-*
    expect(result.actionsCount).toBeGreaterThanOrEqual(totalSpansChild)

    // Cleanup tmpDir post-test (mimicking caller responsibility)
    await fs.rm(result.bootstrapFactsDir!, { recursive: true, force: true })
  }, 60_000)
})
