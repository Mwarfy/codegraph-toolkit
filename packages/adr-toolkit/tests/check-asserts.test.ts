/**
 * Tests pour checkAsserts — ts-morph asserts.
 *
 * Le fixture sample-project a 2 ADRs avec asserts. Un assert qui passe
 * (StateService existe) + un assert qui pète après mutation (rename).
 */

import { describe, it, expect } from 'vitest'
import { mkdtemp, cp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkAsserts } from '../src/check-asserts.js'
import { loadConfig } from '../src/config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(__dirname, 'fixtures/sample-project')

async function copyFixture(): Promise<string> {
  const dest = await mkdtemp(path.join(tmpdir(), 'adr-asserts-'))
  await cp(FIXTURE, dest, { recursive: true })
  return dest
}

describe('checkAsserts', () => {
  it('passe quand tous les symboles existent (StateService + getInstance + emit)', async () => {
    const root = await copyFixture()
    const config = await loadConfig(root)
    const result = await checkAsserts({ config })
    expect(result.failed).toBe(0)
    expect(result.passed).toBe(result.total)
    expect(result.total).toBeGreaterThanOrEqual(3)
    await rm(root, { recursive: true, force: true })
  })

  it('pète si un symbole est renommé', async () => {
    const root = await copyFixture()
    // Rename StateService → _StateService dans le fichier source
    const stateFile = path.join(root, 'src/services/state-service.ts')
    const original = await readFile(stateFile, 'utf-8')
    const mutated = original.replace(/class StateService/, 'class _StateService')
    await writeFile(stateFile, mutated, 'utf-8')

    const config = await loadConfig(root)
    const result = await checkAsserts({ config })
    expect(result.failed).toBeGreaterThan(0)
    const stateAssertFails = result.results.filter(
      r => !r.ok && r.symbol === 'services/state-service#StateService',
    )
    expect(stateAssertFails.length).toBe(1)
    expect(stateAssertFails[0].reason).toMatch(/non trouvé/)
    await rm(root, { recursive: true, force: true })
  })
})
