// ADR-026 phase C — tests du caching Salsa du runner Datalog.
/**
 * Vérifie sur fixture mini :
 *   1. `runDatalogDetectors({ incremental: true })` retourne les mêmes
 *      résultats que `incremental: false` sur cold path.
 *   2. Warm path (2e run successif) : `extractMs` < 50ms (vs ~quelques s
 *      cold). C'est le proof-of-concept du Salsa cache per-file.
 *   3. Le runner sans setup Salsa context throw — protégé par le check
 *      `getIncrementalProject()` dans queries.ts.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { Project } from 'ts-morph'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runDatalogDetectors } from '../src/datalog-detectors/runner.js'
import {
  fileContent, projectFiles, setIncrementalContext,
} from '../src/incremental/queries.js'
import { sharedDb } from '../src/incremental/database.js'

function setupFixture(): { rootDir: string; files: string[]; project: Project } {
  const rootDir = mkdtempSync(join(tmpdir(), 'codegraph-c1-'))
  mkdirSync(join(rootDir, 'src'), { recursive: true })
  writeFileSync(join(rootDir, 'src', 'a.ts'), `
    export function compute() {
      const TIMEOUT = 5000
      setInterval(() => {}, 30000)
      return eval('1+1')
    }
  `, 'utf-8')
  writeFileSync(join(rootDir, 'src', 'b.ts'), `
    import * as crypto from 'crypto'
    export function hash(s: string) {
      return crypto.createHash('md5').update(s).digest('hex')
    }
  `, 'utf-8')

  const files = ['src/a.ts', 'src/b.ts']
  const project = new Project({ skipAddingFilesFromTsConfig: true })
  for (const f of files) project.addSourceFileAtPathIfExists(join(rootDir, f))
  return { rootDir, files, project }
}

describe('runDatalogDetectors — Salsa caching (Phase C)', () => {
  beforeEach(() => {
    // Reset Salsa cells entre tests pour isolation
    sharedDb.reset()
  })

  it('produces identical outputs cold vs incremental warm', async () => {
    const { rootDir, files, project } = setupFixture()
    const cold = await runDatalogDetectors({ project, files, rootDir })

    setIncrementalContext({ project, rootDir })
    for (const f of files) fileContent.set(f, readFileSync(join(rootDir, f), 'utf-8'))
    projectFiles.set('all', files)
    const warm = await runDatalogDetectors({ project, files, rootDir, incremental: true })

    // Compare des fields canoniques (les autres devraient suivre)
    expect(JSON.stringify(warm.magicNumbers)).toBe(JSON.stringify(cold.magicNumbers))
    expect(JSON.stringify(warm.evalCalls)).toBe(JSON.stringify(cold.evalCalls))
    expect(JSON.stringify(warm.cryptoCalls)).toBe(JSON.stringify(cold.cryptoCalls))
    expect(warm.stats.tuplesIn).toBe(cold.stats.tuplesIn)
    expect(warm.stats.tuplesOut).toBe(cold.stats.tuplesOut)
  })

  it('warm path skips extractMs (Salsa cache hit)', async () => {
    const { rootDir, files, project } = setupFixture()
    setIncrementalContext({ project, rootDir })
    for (const f of files) fileContent.set(f, readFileSync(join(rootDir, f), 'utf-8'))
    projectFiles.set('all', files)

    // Run 1 (cold incremental — populate cells)
    const run1 = await runDatalogDetectors({ project, files, rootDir, incremental: true })

    // Run 2 (warm — toutes les cells hit)
    const run2 = await runDatalogDetectors({ project, files, rootDir, incremental: true })

    // extractMs warm doit être très court (juste l'iter sur cells, pas de walk AST)
    expect(run2.stats.extractMs).toBeLessThan(run1.stats.extractMs)
    // Sur fixture mini, warm extract devrait être < 10ms
    expect(run2.stats.extractMs).toBeLessThan(50)
  })

  it('picks up newly added files when projectFiles changes', async () => {
    const { rootDir, files, project } = setupFixture()
    setIncrementalContext({ project, rootDir })
    for (const f of files) fileContent.set(f, readFileSync(join(rootDir, f), 'utf-8'))
    projectFiles.set('all', files)

    const run1 = await runDatalogDetectors({ project, files, rootDir, incremental: true })
    const run1Magic = run1.magicNumbers.length

    // Ajouter un nouveau fichier avec magic numbers
    writeFileSync(join(rootDir, 'src', 'c.ts'), `
      export const RETRY_DELAY = 7777
      export function poll() { setTimeout(() => {}, 88888) }
    `, 'utf-8')
    const newFiles = [...files, 'src/c.ts']
    project.addSourceFileAtPathIfExists(join(rootDir, 'src', 'c.ts'))
    fileContent.set('src/c.ts', readFileSync(join(rootDir, 'src/c.ts'), 'utf-8'))
    projectFiles.set('all', newFiles)

    const run2 = await runDatalogDetectors({
      project, files: newFiles, rootDir, incremental: true,
    })
    expect(run2.magicNumbers.length).toBeGreaterThan(run1Magic)
    // Les magic numbers de a.ts (cached) restent identiques — invalidation
    // sélective.
    const aMagicCount1 = run1.magicNumbers.filter((m) => m.file === 'src/a.ts').length
    const aMagicCount2 = run2.magicNumbers.filter((m) => m.file === 'src/a.ts').length
    expect(aMagicCount2).toBe(aMagicCount1)
  })
})
