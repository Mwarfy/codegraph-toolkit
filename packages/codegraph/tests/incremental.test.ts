/**
 * Tests du mode incremental Salsa (Sprint 2 — Phase 1).
 *
 * Couverture :
 *   1. Output incremental === output legacy (parité fonctionnelle)
 *   2. Cache hit total sur 2e run sans modif (les `*OfFile` ne sont
 *      pas re-misses)
 *   3. Invalidation ciblée : modif 1 fichier → seul ce fichier réparse
 *   4. Suppression d'un fichier de la liste → re-aggreate sans toucher
 *      aux per-file restants
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { createSharedProject } from '../src/detectors/unused-exports.js'
import { analyzeEnvUsage } from '../src/extractors/env-usage.js'
import { analyzeOauthScopeLiterals } from '../src/extractors/oauth-scope-literals.js'
import { sharedDb } from '../src/incremental/database.js'
import {
  fileContent,
  projectFiles,
  setIncrementalContext,
} from '../src/incremental/queries.js'
import { allEnvUsage, envUsageOfFile } from '../src/incremental/env-usage.js'
import {
  allOauthScopeLiterals,
  oauthScopesOfFile,
} from '../src/incremental/oauth-scope-literals.js'

let fixtureRoot: string
let files: string[]

const FILE_A = `// @ts-nocheck
const a = process.env.A_VAR
const apiKey = 'https://www.googleapis.com/auth/youtube.upload'
`

const FILE_B = `// @ts-nocheck
function readB() {
  return process.env.B_VAR ?? 'default'
}
`

const FILE_C = `// @ts-nocheck
export const noEnvHere = 42
`

beforeAll(async () => {
  fixtureRoot = await mkdtemp(path.join(tmpdir(), 'incremental-'))
  await mkdir(fixtureRoot, { recursive: true })
  await writeFile(path.join(fixtureRoot, 'a.ts'), FILE_A)
  await writeFile(path.join(fixtureRoot, 'b.ts'), FILE_B)
  await writeFile(path.join(fixtureRoot, 'c.ts'), FILE_C)
  await writeFile(
    path.join(fixtureRoot, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext' } }),
  )
  files = ['a.ts', 'b.ts', 'c.ts']
})

afterAll(async () => {
  await rm(fixtureRoot, { recursive: true, force: true })
})

beforeEach(() => {
  // Reset l'état (cells + revision + stats) entre tests. On garde le
  // registry intact — les wrappers de queries.ts/env-usage.ts/etc. sont
  // déclarés au top-level des modules, ils ne peuvent pas se ré-enregistrer.
  sharedDb.resetState()
})

function setupContext() {
  const project = createSharedProject(fixtureRoot, files, path.join(fixtureRoot, 'tsconfig.json'))
  setIncrementalContext({ project, rootDir: fixtureRoot })
  fileContent.set('a.ts', FILE_A)
  fileContent.set('b.ts', FILE_B)
  fileContent.set('c.ts', FILE_C)
  projectFiles.set('all', files)
  return project
}

describe('incremental env-usage', () => {
  it('matches legacy output (parity)', async () => {
    setupContext()
    const project = createSharedProject(fixtureRoot, files, path.join(fixtureRoot, 'tsconfig.json'))

    const incrResult = allEnvUsage.get('all')
    const legacyResult = await analyzeEnvUsage(fixtureRoot, files, project)

    expect(JSON.stringify(incrResult)).toBe(JSON.stringify(legacyResult))
  })

  it('caches per-file scan on second run with no changes', () => {
    setupContext()

    // 1er run : warm le cache
    const first = allEnvUsage.get('all')
    expect(first.length).toBeGreaterThan(0)

    const missesAfterFirst = sharedDb.stats().misses['envUsageOfFile'] ?? 0
    expect(missesAfterFirst).toBe(3) // a, b, c tous parsés

    // 2e run : re-set même contenu (Object.is égal pour FILE_A/B/C constants)
    fileContent.set('a.ts', FILE_A)
    fileContent.set('b.ts', FILE_B)
    fileContent.set('c.ts', FILE_C)
    projectFiles.set('all', files)

    const second = allEnvUsage.get('all')
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))

    // Aucun miss supplémentaire sur envUsageOfFile : cache hit total.
    const missesAfterSecond = sharedDb.stats().misses['envUsageOfFile'] ?? 0
    expect(missesAfterSecond).toBe(missesAfterFirst)
  })

  it('only re-scans the modified file', () => {
    setupContext()

    // 1er run : warm
    allEnvUsage.get('all')
    const baseline = sharedDb.stats().misses['envUsageOfFile'] ?? 0

    // Modif b.ts : nouveau contenu (donc Object.is false → changedAt bouge)
    const NEW_B = `// @ts-nocheck
function readB() {
  return process.env.B_VAR_RENAMED ?? 'default'
}
`
    fileContent.set('b.ts', NEW_B)
    // Note : on ne met pas à jour le ts-morph Project ici (compromis Sprint 2)
    // mais le test vérifie l'INVALIDATION cache, pas le résultat AST.
    // Pour un test bout-en-bout, voir le test analyze() ci-dessous.

    allEnvUsage.get('all')
    const afterModif = sharedDb.stats().misses['envUsageOfFile'] ?? 0

    // Exactement 1 re-scan : b.ts. a.ts et c.ts gardent leur cache.
    expect(afterModif - baseline).toBe(1)
  })
})

describe('incremental oauth-scope-literals', () => {
  it('matches legacy output (parity)', async () => {
    setupContext()
    const project = createSharedProject(fixtureRoot, files, path.join(fixtureRoot, 'tsconfig.json'))

    const incrResult = allOauthScopeLiterals.get('all')
    const legacyResult = await analyzeOauthScopeLiterals(fixtureRoot, files, project)

    expect(JSON.stringify(incrResult)).toBe(JSON.stringify(legacyResult))
  })

  it('caches per-file scan on second run with no changes', () => {
    setupContext()

    const first = allOauthScopeLiterals.get('all')
    expect(first.length).toBe(1) // seul a.ts a un scope literal

    const missesAfterFirst = sharedDb.stats().misses['oauthScopesOfFile'] ?? 0
    expect(missesAfterFirst).toBe(3)

    fileContent.set('a.ts', FILE_A)
    fileContent.set('b.ts', FILE_B)
    fileContent.set('c.ts', FILE_C)
    projectFiles.set('all', files)

    const second = allOauthScopeLiterals.get('all')
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))

    const missesAfterSecond = sharedDb.stats().misses['oauthScopesOfFile'] ?? 0
    expect(missesAfterSecond).toBe(missesAfterFirst)
  })

  it('re-scans only the modified file', () => {
    setupContext()
    allOauthScopeLiterals.get('all')
    const baseline = sharedDb.stats().misses['oauthScopesOfFile'] ?? 0

    // Modif a.ts : ajout d'un 2e scope literal
    const NEW_A = FILE_A + `\nconst k2 = 'https://www.googleapis.com/auth/youtube.readonly'\n`
    fileContent.set('a.ts', NEW_A)

    const after = allOauthScopeLiterals.get('all')
    expect(after.length).toBe(2)

    const afterMisses = sharedDb.stats().misses['oauthScopesOfFile'] ?? 0
    expect(afterMisses - baseline).toBe(1)
  })
})

describe('incremental aggregate behavior', () => {
  it('aggregator re-runs when projectFiles changes but per-file results stay cached', () => {
    setupContext()

    // 1er run avec 3 fichiers
    allEnvUsage.get('all')
    const baseline = sharedDb.stats().misses['envUsageOfFile'] ?? 0

    // Retire c.ts de la liste — l'agrégat doit re-runner mais pas a/b/c.
    projectFiles.set('all', ['a.ts', 'b.ts'])

    allEnvUsage.get('all')
    const after = sharedDb.stats().misses['envUsageOfFile'] ?? 0

    // a.ts et b.ts toujours en cache. c.ts pas re-scanné (pas dans la liste).
    expect(after).toBe(baseline)

    // Mais l'aggregateur a bien re-tourné (on l'a forcé en changeant l'input)
    const aggMisses = sharedDb.stats().misses['allEnvUsage'] ?? 0
    expect(aggMisses).toBeGreaterThanOrEqual(2)
  })
})
