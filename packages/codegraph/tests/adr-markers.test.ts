/**
 * Contract test pour `collectAdrMarkers`.
 *
 * Vérifie que les marqueurs `// ADR-NNN` du code source sont correctement
 * détectés selon la convention partagée avec @liby-tools/adr-toolkit
 * (cf. plan §3.8 — start-of-comment uniquement, pas de prose match).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { collectAdrMarkers } from '../src/synopsis/adr-markers.js'

let fixtureRoot: string

beforeAll(async () => {
  fixtureRoot = await mkdtemp(path.join(tmpdir(), 'adr-markers-'))
  await mkdir(path.join(fixtureRoot, 'src'), { recursive: true })
  await mkdir(path.join(fixtureRoot, 'scripts'), { recursive: true })
  await mkdir(path.join(fixtureRoot, 'node_modules'), { recursive: true })

  // Single-ADR marker
  await writeFile(
    path.join(fixtureRoot, 'src/foo.ts'),
    `// ADR-001\nexport const foo = 1\n`,
  )

  // Multi-ADR marker
  await writeFile(
    path.join(fixtureRoot, 'src/bar.ts'),
    `// ADR-002, ADR-003\nexport const bar = 2\n`,
  )

  // Marker with role suffix
  await writeFile(
    path.join(fixtureRoot, 'src/baz.ts'),
    `// ADR-004: orchestrator du flux principal\nexport const baz = 3\n`,
  )

  // Shell-style marker
  await writeFile(
    path.join(fixtureRoot, 'scripts/deploy.sh'),
    `#!/bin/bash\n# ADR-008\necho "deploy"\n`,
  )

  // No marker — must be absent from output
  await writeFile(
    path.join(fixtureRoot, 'src/no-marker.ts'),
    `export const x = 1\n`,
  )

  // Prose mention — must NOT match (faux positif filter)
  await writeFile(
    path.join(fixtureRoot, 'src/prose.ts'),
    `// cf. ADR-005 pour le contexte historique\nexport const z = 1\n`,
  )

  // Skipped dir — must be absent
  await writeFile(
    path.join(fixtureRoot, 'node_modules/skipped.ts'),
    `// ADR-999\nexport const skip = 1\n`,
  )
})

afterAll(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true })
})

describe('collectAdrMarkers', () => {
  it('détecte single-ADR marker', async () => {
    const markers = await collectAdrMarkers(fixtureRoot)
    expect(markers.get('src/foo.ts')).toEqual(['001'])
  })

  it('détecte multi-ADR marker (séparé par virgule)', async () => {
    const markers = await collectAdrMarkers(fixtureRoot)
    expect(markers.get('src/bar.ts')).toEqual(['002', '003'])
  })

  it('détecte marker avec role suffix après deux-points', async () => {
    const markers = await collectAdrMarkers(fixtureRoot)
    expect(markers.get('src/baz.ts')).toEqual(['004'])
  })

  it('détecte marker shell-style (#)', async () => {
    const markers = await collectAdrMarkers(fixtureRoot)
    expect(markers.get('scripts/deploy.sh')).toEqual(['008'])
  })

  it('exclut fichiers sans marker', async () => {
    const markers = await collectAdrMarkers(fixtureRoot)
    expect(markers.has('src/no-marker.ts')).toBe(false)
  })

  it('exclut prose mention ("cf. ADR-NNN pour ...")', async () => {
    const markers = await collectAdrMarkers(fixtureRoot)
    expect(markers.has('src/prose.ts')).toBe(false)
  })

  it('skip node_modules par défaut', async () => {
    const markers = await collectAdrMarkers(fixtureRoot)
    expect(markers.has('node_modules/skipped.ts')).toBe(false)
  })

  it('résultats déterministes (2 runs identiques)', async () => {
    const a = await collectAdrMarkers(fixtureRoot)
    const b = await collectAdrMarkers(fixtureRoot)
    expect(JSON.stringify([...a.entries()].sort()))
      .toBe(JSON.stringify([...b.entries()].sort()))
  })
})
