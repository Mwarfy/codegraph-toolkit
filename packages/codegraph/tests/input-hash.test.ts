// ADR-027
/**
 * Tests pour le content-addressed inputHash (Phase 2 d'ADR-027).
 * Vérifie :
 *   - Déterminisme : 2 runs sur le même contenu → même hash
 *   - Invalidation : modification d'un fichier source → hash différent
 *   - Invalidation : modification de la config → hash différent
 *   - Stabilité d'ordre : ordre du paramètre `filePaths` ne change pas le hash
 *   - Suppression : fichier supprimé → hash différent
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { computeInputHash } from '../src/incremental/input-hash.js'
import type { CodeGraphConfig } from '../src/core/types.js'

async function makeFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'input-hash-'))
  await fs.mkdir(path.join(dir, 'src'))
  await fs.writeFile(path.join(dir, 'src/a.ts'), 'export const a = 1\n')
  await fs.writeFile(path.join(dir, 'src/b.ts'), 'export const b = 2\n')
  return dir
}

function configFor(rootDir: string): CodeGraphConfig {
  return {
    rootDir,
    include: ['**/*.ts'],
    exclude: [],
    entryPoints: [],
    detectors: [],
    snapshotDir: path.join(rootDir, '.codegraph'),
    maxSnapshots: 50,
  }
}

describe('computeInputHash — ADR-027 Phase 2', () => {
  let dir: string

  beforeEach(async () => {
    dir = await makeFixture()
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('déterministe : 2 runs sur même contenu → même hash', async () => {
    const config = configFor(dir)
    const files = ['src/a.ts', 'src/b.ts']
    const r1 = await computeInputHash(config, files)
    const r2 = await computeInputHash(config, files)
    expect(r2.hash).toBe(r1.hash)
  })

  it('stable face à l\'ordre de filePaths (tri interne déterministe)', async () => {
    const config = configFor(dir)
    const r1 = await computeInputHash(config, ['src/a.ts', 'src/b.ts'])
    const r2 = await computeInputHash(config, ['src/b.ts', 'src/a.ts'])
    expect(r2.hash).toBe(r1.hash)
  })

  it('invalide quand un fichier source change', async () => {
    const config = configFor(dir)
    const files = ['src/a.ts', 'src/b.ts']
    const r1 = await computeInputHash(config, files)
    await fs.writeFile(path.join(dir, 'src/a.ts'), 'export const a = 999\n')
    const r2 = await computeInputHash(config, files)
    expect(r2.hash).not.toBe(r1.hash)
  })

  it('invalide quand un fichier est supprimé de la liste', async () => {
    const config = configFor(dir)
    const r1 = await computeInputHash(config, ['src/a.ts', 'src/b.ts'])
    const r2 = await computeInputHash(config, ['src/a.ts'])
    expect(r2.hash).not.toBe(r1.hash)
  })

  it('invalide quand la config présente change', async () => {
    const config = configFor(dir)
    const files = ['src/a.ts', 'src/b.ts']

    const r1 = await computeInputHash(config, files)

    // Écrit un codegraph.config.json qui sera hashé au prochain run
    await fs.writeFile(
      path.join(dir, 'codegraph.config.json'),
      JSON.stringify({ include: ['**/*.ts'] }),
    )
    const r2 = await computeInputHash(config, files)
    expect(r2.hash).not.toBe(r1.hash)

    // Modifie le config → hash change encore
    await fs.writeFile(
      path.join(dir, 'codegraph.config.json'),
      JSON.stringify({ include: ['**/*.ts', '**/*.tsx'] }),
    )
    const r3 = await computeInputHash(config, files)
    expect(r3.hash).not.toBe(r2.hash)
  })

  it('expose le fileCount dans le contexte', async () => {
    const config = configFor(dir)
    const r = await computeInputHash(config, ['src/a.ts', 'src/b.ts'])
    expect(r.ctx.fileCount).toBe(2)
  })

  it('toolingVersion non-vide (workspace dev OU release)', async () => {
    const config = configFor(dir)
    const r = await computeInputHash(config, [])
    expect(r.ctx.toolingVersion).toMatch(/^\d+\.\d+\.\d+(-dev)?$/)
  })
})
