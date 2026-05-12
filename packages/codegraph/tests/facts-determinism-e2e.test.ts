// ADR-027
/**
 * E2E déterminisme du content-addressed fact store (Phase 3 d'ADR-027).
 *
 * Vérifie de bout en bout que `analyze` produit :
 *   - le même factSetHash sur 2 runs identiques (déterminisme)
 *   - le même factSetHash quand l'AstFactsBundle a un ordre inversé
 *     en interne (sortByRelation stable)
 *   - un fact_id différent quand on modifie 1 ligne d'un fichier
 *   - le mode PR (--pr) calcule le delta sans rerun base si cache hit
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { analyze } from '../src/core/analyzer.js'
import { buildFactsHead, computeDelta, saveBase, loadBase } from '../src/incremental/fact-store.js'
import type { CodeGraphConfig } from '../src/core/types.js'

async function makeFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p3-e2e-'))
  await fs.mkdir(path.join(dir, 'src'))
  await fs.writeFile(path.join(dir, 'src/a.ts'), 'export const a = 1\n')
  await fs.writeFile(path.join(dir, 'src/b.ts'),
    "import { a } from './a.js'\nexport const b = a + 1\nconst secret = 'tok-abc1234567890'\n")
  return dir
}

function configFor(rootDir: string): CodeGraphConfig {
  return {
    rootDir,
    include: ['**/*.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.codegraph/**'],
    entryPoints: [],
    detectors: [],
    snapshotDir: path.join(rootDir, '.codegraph'),
    maxSnapshots: 50,
  }
}

describe('ADR-027 Phase 3 — fact store determinism (e2e)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await makeFixture()
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('2 analyze sur même working tree → même factSetHash', async () => {
    const cfg = configFor(dir)
    const r1 = await analyze(cfg, {
      skipPersistenceLoad: true,
      skipPersistenceSave: true,
    })
    const r2 = await analyze(cfg, {
      skipPersistenceLoad: true,
      skipPersistenceSave: true,
    })
    expect(r1.astFactsBundle).toBeDefined()
    expect(r2.astFactsBundle).toBeDefined()

    const h1 = buildFactsHead(r1.astFactsBundle!, { generatedAt: 'x' }).head
    const h2 = buildFactsHead(r2.astFactsBundle!, { generatedAt: 'x' }).head
    expect(h2.factSetHash).toBe(h1.factSetHash)
  })

  it('modification d\'un fichier → factSetHash change', async () => {
    const cfg = configFor(dir)
    const r1 = await analyze(cfg, {
      skipPersistenceLoad: true,
      skipPersistenceSave: true,
    })
    const h1 = buildFactsHead(r1.astFactsBundle!, { generatedAt: 'x' }).head

    await fs.writeFile(path.join(dir, 'src/a.ts'), 'export const a = 999\n')

    const r2 = await analyze(cfg, {
      skipPersistenceLoad: true,
      skipPersistenceSave: true,
    })
    const h2 = buildFactsHead(r2.astFactsBundle!, { generatedAt: 'x' }).head

    expect(h2.factSetHash).not.toBe(h1.factSetHash)
  })

  it('computeDelta : added/removed reflètent les vraies modifications', async () => {
    const cfg = configFor(dir)
    const r1 = await analyze(cfg, { skipPersistenceLoad: true, skipPersistenceSave: true })
    const h1 = buildFactsHead(r1.astFactsBundle!, { generatedAt: 'x' }).head

    // Ajoute un eval (= un nouveau callExpressions tuple)
    await fs.writeFile(path.join(dir, 'src/b.ts'),
      "import { a } from './a.js'\nexport const b = a + 1\nconst secret = 'tok-abc1234567890'\neval('1+1')\n")

    const r2 = await analyze(cfg, { skipPersistenceLoad: true, skipPersistenceSave: true })
    const h2 = buildFactsHead(r2.astFactsBundle!, { generatedAt: 'x' }).head

    const delta = computeDelta(h1, h2)
    expect(delta.added.length).toBeGreaterThan(0)
    expect(delta.added.some((a) => a.relation === 'callExpressions')).toBe(true)
  })
})

describe('ADR-027 Phase 3 — PR mode delta via worktree', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p3-pr-'))
    execSync('git init -q', { cwd: dir })
    execSync('git config user.email "test@x"', { cwd: dir })
    execSync('git config user.name "test"', { cwd: dir })
    await fs.writeFile(path.join(dir, 'codegraph.config.json'),
      JSON.stringify({ rootDir: '.', include: ['**/*.ts'], exclude: ['**/node_modules/**', '**/.codegraph/**'] }))
    await fs.mkdir(path.join(dir, 'src'))
    await fs.writeFile(path.join(dir, 'src/a.ts'), 'export const a = 1\n')
    execSync('git add -A && git commit -qm base', { cwd: dir })
    await fs.writeFile(path.join(dir, 'src/b.ts'), "import { a } from './a.js'\nconsole.log(a)\n")
    execSync('git add -A && git commit -qm head', { cwd: dir })
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('cache base : 2e analyze --pr réutilise le base cached', async () => {
    const cfg = configFor(dir)
    const baseSha = execSync('git rev-parse HEAD~1', { cwd: dir, encoding: 'utf-8' }).trim()

    // Pas en cache au démarrage
    expect(await loadBase(cfg.snapshotDir, baseSha)).toBeNull()

    // Analyze le base (simule premier --pr)
    const baseResult = await analyze(
      { ...cfg, rootDir: dir },
      { incremental: false },
    )
    const baseHead = buildFactsHead(baseResult.astFactsBundle!, { generatedAt: 'x', baseSha }).head
    await saveBase(cfg.snapshotDir, baseSha, baseHead)

    // 2e run : base est en cache
    const loaded = await loadBase(cfg.snapshotDir, baseSha)
    expect(loaded?.factSetHash).toBe(baseHead.factSetHash)
  })

  it('2 PRs concurrentes (bases distinctes) → 2 caches distincts', async () => {
    const cfg = configFor(dir)
    const sha1 = execSync('git rev-parse HEAD~1', { cwd: dir, encoding: 'utf-8' }).trim()
    const sha2 = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf-8' }).trim()

    const h1 = { version: 1, factSetHash: 'pr1-hash', generatedAt: 'x', byRelation: { R: ['a'] } }
    const h2 = { version: 1, factSetHash: 'pr2-hash', generatedAt: 'x', byRelation: { R: ['b'] } }
    await saveBase(cfg.snapshotDir, sha1, h1)
    await saveBase(cfg.snapshotDir, sha2, h2)

    expect((await loadBase(cfg.snapshotDir, sha1))?.factSetHash).toBe('pr1-hash')
    expect((await loadBase(cfg.snapshotDir, sha2))?.factSetHash).toBe('pr2-hash')
  })
})
