/**
 * Tests pour generateBrief — output cohérent.
 */

import { describe, it, expect } from 'vitest'
import { mkdtemp, cp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateBrief } from '../src/brief.js'
import { regenerateAnchors } from '../src/regenerate-anchors.js'
import { loadConfig } from '../src/config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(__dirname, 'fixtures/sample-project')

async function copyFixture(): Promise<string> {
  const dest = await mkdtemp(path.join(tmpdir(), 'adr-brief-'))
  await cp(FIXTURE, dest, { recursive: true })
  return dest
}

describe('generateBrief', () => {
  it('produit un brief avec les ADRs + fichiers gouvernés', async () => {
    const root = await copyFixture()
    const config = await loadConfig(root)
    // Régen d'abord pour que ## Anchored in soit peuplé (sinon brief vide)
    await regenerateAnchors({ config, checkOnly: false })
    const result = await generateBrief({ config })
    expect(result.adrCount).toBeGreaterThanOrEqual(2)
    expect(result.anchoredFileCount).toBeGreaterThanOrEqual(2)
    const content = await readFile(result.outputPath, 'utf-8')
    expect(content).toContain('# Boot Brief')
    expect(content).toContain('ADR-001')
    expect(content).toContain('ADR-002')
    expect(content).toContain('src/services/state-service.ts')
    expect(content).toContain('src/core/event-bus.ts')
    expect(content).toContain('AUTO-GÉNÉRÉ par @liby/adr-toolkit')
    await rm(root, { recursive: true, force: true })
  })

  it('output déterministe (2 invocations identiques sur même fixture)', async () => {
    const root = await copyFixture()
    const config = await loadConfig(root)
    await regenerateAnchors({ config, checkOnly: false })
    await generateBrief({ config })
    const first = await readFile(path.join(root, 'CLAUDE-CONTEXT.md'), 'utf-8')
    await generateBrief({ config })
    const second = await readFile(path.join(root, 'CLAUDE-CONTEXT.md'), 'utf-8')
    // L'activité git récente peut varier ; on compare les sections stables.
    const stripGitLog = (s: string) =>
      s.replace(/## Activité récente[\s\S]+?```[\s\S]+?```/g, '## (git omitted)')
    expect(stripGitLog(first)).toBe(stripGitLog(second))
    await rm(root, { recursive: true, force: true })
  })
})
