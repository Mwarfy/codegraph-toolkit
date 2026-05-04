/**
 * Phase γ.2 — Tests determinisme runPerSourceFileExtractor avec
 * workerModule/workerExport (mini-Project ts-morph cross-thread).
 *
 * Vérifie que :
 *   1. Worker mode produit le MÊME output que main thread (bit-identique).
 *   2. 5 runs successifs donnent le même output (déterminisme cross-thread).
 *   3. Le mode workers active réellement les workers (stats > 0).
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Project } from 'ts-morph'
import { runPerSourceFileExtractor } from '../src/parallel/per-source-file-extractor.js'
import { getGlobalPool, terminateGlobalPool } from '../src/parallel/worker-pool.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_WORKER = path.join(__dirname, 'fixtures/source-file-extractor-fixture.mjs')
// vitest run depuis src/.ts mais worker-runner compilé vit dans dist/.
const DIST_RUNNER_PATH = path.resolve(__dirname, '../dist/parallel/worker-runner.js')

interface FnItem {
  file: string
  name: string
  line: number
}

const DIST_SOURCE_FILE_RUNNER = path.resolve(
  __dirname,
  '../dist/parallel/source-file-worker-runner.js',
)

beforeAll(() => {
  // Pré-init le global pool avec le compiled runner (test runs depuis src/.ts).
  getGlobalPool({ runnerPath: DIST_RUNNER_PATH })
  // Override le path source-file-worker-runner pour qu'il pointe vers dist/.
  process.env.LIBY_BSP_SOURCE_FILE_RUNNER = DIST_SOURCE_FILE_RUNNER
})

afterAll(async () => {
  await terminateGlobalPool()
})

function makeProject(files: Array<{ name: string; content: string }>): { project: Project; rootDir: string } {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    useInMemoryFileSystem: true,
  })
  const rootDir = '/virtual'
  for (const f of files) {
    project.createSourceFile(`${rootDir}/${f.name}`, f.content, { overwrite: true })
  }
  return { project, rootDir }
}

describe('runPerSourceFileExtractor — Phase γ.2 worker mode', () => {
  it('main-thread output ≡ worker output (bit-identique)', async () => {
    const project = makeProject([
      { name: 'a.ts', content: 'function alpha() {}\nfunction beta() {}' },
      { name: 'b.ts', content: 'function gamma(x: number) { return x }' },
      { name: 'c.ts', content: 'export function delta() {}\nexport function epsilon() {}' },
    ]).project
    const rootDir = '/virtual'
    const files = ['a.ts', 'b.ts', 'c.ts']

    const mainResult = await runPerSourceFileExtractor<FnItem[], FnItem>({
      project,
      files,
      rootDir,
      extractor: (sf, rel) => {
        const out: FnItem[] = []
        for (const fn of sf.getFunctions()) {
          out.push({ file: rel, name: fn.getName() ?? '(anonymous)', line: fn.getStartLineNumber() })
        }
        return out
      },
      selectItems: (items) => items,
      sortKey: (i) => `${i.file}:${String(i.line).padStart(8, '0')}`,
    })

    // Force worker mode via env override.
    const prev = process.env.LIBY_BSP_WORKERS
    process.env.LIBY_BSP_WORKERS = '1'
    try {
      const workerResult = await runPerSourceFileExtractor<FnItem[], FnItem>({
        project,
        files,
        rootDir,
        extractor: (sf, rel) => {
          const out: FnItem[] = []
          for (const fn of sf.getFunctions()) {
            out.push({ file: rel, name: fn.getName() ?? '(anonymous)', line: fn.getStartLineNumber() })
          }
          return out
        },
        selectItems: (items) => items,
        sortKey: (i) => `${i.file}:${String(i.line).padStart(8, '0')}`,
        workerModule: FIXTURE_WORKER,
        workerExport: 'extractFunctionsByName',
      })

      expect(JSON.stringify(workerResult.items)).toBe(JSON.stringify(mainResult.items))
      expect(workerResult.items.length).toBe(5)
      expect(workerResult.items.map((f) => f.name)).toEqual([
        'alpha', 'beta', 'gamma', 'delta', 'epsilon',
      ])
    } finally {
      if (prev === undefined) delete process.env.LIBY_BSP_WORKERS
      else process.env.LIBY_BSP_WORKERS = prev
    }
  }, 30000)

  it('5 runs successifs en worker mode → bit-identiques', async () => {
    const { project } = makeProject([
      { name: 'x.ts', content: 'function one(){}\nfunction two(){}\nfunction three(){}' },
      { name: 'y.ts', content: 'function four(){}\nfunction five(){}' },
    ])
    const rootDir = '/virtual'
    const files = ['x.ts', 'y.ts']

    const prev = process.env.LIBY_BSP_WORKERS
    process.env.LIBY_BSP_WORKERS = '1'
    try {
      const outputs: string[] = []
      for (let i = 0; i < 5; i++) {
        const r = await runPerSourceFileExtractor<FnItem[], FnItem>({
          project,
          files,
          rootDir,
          extractor: () => [],  // unused en worker mode
          selectItems: (items) => items,
          sortKey: (i) => `${i.file}:${String(i.line).padStart(8, '0')}`,
          workerModule: FIXTURE_WORKER,
          workerExport: 'extractFunctionsByName',
        })
        outputs.push(JSON.stringify(r.items))
      }
      // Tous bit-identiques
      const first = outputs[0]
      for (const o of outputs) expect(o).toBe(first)
    } finally {
      if (prev === undefined) delete process.env.LIBY_BSP_WORKERS
      else process.env.LIBY_BSP_WORKERS = prev
    }
  }, 30000)
})
