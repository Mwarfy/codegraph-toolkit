/**
 * Tests pour regenerateAnchors — détection de drift + idempotence.
 *
 * Utilise un tmpdir pour ne pas polluer le fixture statique. Le fixture
 * versionné fournit la structure ADRs + src files initiale ; on copie dans
 * tmpdir avant chaque test mutant.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { regenerateAnchors } from '../src/regenerate-anchors.js'
import { loadConfig } from '../src/config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(__dirname, 'fixtures/sample-project')

async function copyFixture(): Promise<string> {
  const dest = await mkdtemp(path.join(tmpdir(), 'adr-regen-'))
  await cp(FIXTURE, dest, { recursive: true })
  return dest
}

describe('regenerateAnchors', () => {
  it('détecte drift en mode --check (fixture initial = anchors pas régen)', async () => {
    const root = await copyFixture()
    const config = await loadConfig(root)
    const result = await regenerateAnchors({ config, checkOnly: true })
    expect(result.drift).toBe(true)
    expect(result.totalMarkers).toBeGreaterThan(0)
    expect(result.adrsWithMarkers).toBeGreaterThan(0)
    expect(result.modified).toEqual([])
    await rm(root, { recursive: true, force: true })
  })

  it('réécrit les ADRs en mode write', async () => {
    const root = await copyFixture()
    const config = await loadConfig(root)
    const result = await regenerateAnchors({ config, checkOnly: false })
    expect(result.drift).toBe(false)
    expect(result.modified.length).toBeGreaterThan(0)
    // Vérifie que ## Anchored in contient bien les fichiers
    const adr1 = await readFile(path.join(root, 'docs/adr/001-singleton-services.md'), 'utf-8')
    expect(adr1).toContain('src/services/state-service.ts')
    expect(adr1).toContain('AUTO-GÉNÉRÉ depuis les marqueurs ADR-NNN')
    await rm(root, { recursive: true, force: true })
  })

  it('idempotence : 2 régen consécutives → pas de drift au 2ème', async () => {
    const root = await copyFixture()
    const config = await loadConfig(root)
    await regenerateAnchors({ config, checkOnly: false })
    const second = await regenerateAnchors({ config, checkOnly: true })
    expect(second.drift).toBe(false)
    expect(second.modified).toEqual([])
    await rm(root, { recursive: true, force: true })
  })

  it('détecte marqueur orphelin (ADR-999 référencé mais inexistant)', async () => {
    const root = await copyFixture()
    await writeFile(
      path.join(root, 'src/orphan.ts'),
      `// ADR-999\nexport const x = 1\n`,
      'utf-8',
    )
    const config = await loadConfig(root)
    const result = await regenerateAnchors({ config, checkOnly: true })
    expect(result.orphanAdrs).toContain('999')
    expect(result.drift).toBe(true)
    await rm(root, { recursive: true, force: true })
  })
})
