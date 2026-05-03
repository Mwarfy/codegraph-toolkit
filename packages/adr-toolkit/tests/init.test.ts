/**
 * Tests pour initProject — scaffold idempotent + détection layout.
 *
 * META-CRITICAL kill : on test la sémantique critique d'initProject sur
 * répertoires temp. Pas d'I/O reseau, pas d'appel git config (skip
 * automatiquement si pas de .git/), juste des fichiers TS écrits sur
 * disque qu'on peut vérifier.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { initProject } from '../src/init.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adr-toolkit-init-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function exists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true } catch { return false }
}

describe('initProject — layout detection', () => {
  it('détecte layout "simple" pour un projet src/ standard', async () => {
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true })
    const result = await initProject(tmpDir)
    expect(result.layout).toBe('simple')
  })

  it('détecte layout "fullstack-monorepo" pour backend/ + frontend/', async () => {
    await fs.mkdir(path.join(tmpDir, 'backend/src'), { recursive: true })
    await fs.mkdir(path.join(tmpDir, 'frontend'), { recursive: true })
    const result = await initProject(tmpDir)
    expect(result.layout).toBe('fullstack-monorepo')
  })

  it('détecte layout "workspaces-monorepo" pour packages/ ou apps/', async () => {
    await fs.mkdir(path.join(tmpDir, 'packages'), { recursive: true })
    const result = await initProject(tmpDir)
    expect(result.layout).toBe('workspaces-monorepo')
  })

  it('fallback "flat" si aucun pattern reconnu', async () => {
    // tmpDir vide — pas de src/, pas de packages/, pas de backend+frontend
    const result = await initProject(tmpDir)
    expect(result.layout).toBe('flat')
  })
})

describe('initProject — file scaffolding', () => {
  it('crée .codegraph-toolkit.json + codegraph.config.json', async () => {
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true })
    const result = await initProject(tmpDir)

    expect(result.created).toContain('.codegraph-toolkit.json')
    expect(result.created).toContain('codegraph.config.json')
    expect(await exists(path.join(tmpDir, '.codegraph-toolkit.json'))).toBe(true)
    expect(await exists(path.join(tmpDir, 'codegraph.config.json'))).toBe(true)
  })

  it('crée docs/adr/_TEMPLATE.md + INDEX.md', async () => {
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true })
    const result = await initProject(tmpDir)
    expect(result.created).toContain('docs/adr/_TEMPLATE.md')
    expect(result.created).toContain('docs/adr/INDEX.md')
    expect(await exists(path.join(tmpDir, 'docs/adr/_TEMPLATE.md'))).toBe(true)
  })

  it('idempotent : 2e run skip les fichiers existants', async () => {
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true })
    const r1 = await initProject(tmpDir)
    expect(r1.created).toContain('.codegraph-toolkit.json')

    const r2 = await initProject(tmpDir)
    expect(r2.created).not.toContain('.codegraph-toolkit.json')
    expect(r2.skipped).toContain('.codegraph-toolkit.json')
  })

  it('respecte un .codegraph-toolkit.json pré-existant (n\'overwrite pas)', async () => {
    const userConfig = { rootDir: '.', adrDir: 'custom/adr' }
    await fs.writeFile(
      path.join(tmpDir, '.codegraph-toolkit.json'),
      JSON.stringify(userConfig, null, 2),
    )
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true })

    const result = await initProject(tmpDir)
    expect(result.skipped).toContain('.codegraph-toolkit.json')

    const written = JSON.parse(
      await fs.readFile(path.join(tmpDir, '.codegraph-toolkit.json'), 'utf-8'),
    )
    expect(written.adrDir).toBe('custom/adr')
  })
})

describe('initProject — stack detection', () => {
  it('warn drizzle-orm si présent dans package.json', async () => {
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true })
    await fs.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { 'drizzle-orm': '^0.30.0' } }),
    )
    const result = await initProject(tmpDir)
    expect(result.warnings.some((w) => w.includes('Drizzle'))).toBe(true)
  })

  it('warn migrations SQL si présentes', async () => {
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true })
    await fs.mkdir(path.join(tmpDir, 'migrations'), { recursive: true })
    const result = await initProject(tmpDir)
    expect(result.warnings.some((w) => w.includes('Migrations .sql'))).toBe(true)
  })

  it('warn Prisma not yet supported', async () => {
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true })
    await fs.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { '@prisma/client': '^5.0.0' } }),
    )
    const result = await initProject(tmpDir)
    expect(result.warnings.some((w) => w.includes('Prisma'))).toBe(true)
  })
})
