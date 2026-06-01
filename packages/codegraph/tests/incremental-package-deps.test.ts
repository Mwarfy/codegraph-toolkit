// ADR-007
/**
 * Test focalisé pour la dérivation Salsa incrémentale package-deps
 * (`incremental/package-deps.ts`). Comble un gap : cette dérivation n'avait
 * aucun test direct alors qu'elle co-évolue avec l'extractor legacy
 * (cf. COMPOSITE-COCHANGE-WITHOUT-COTEST).
 *
 * Vérifie que `allPackageDeps` détecte une dep déclarée mais jamais importée
 * (declared-unused), via le harness `analyze --incremental` qui seed les
 * inputs Salsa (projectFiles + packageManifestsInput).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { analyze } from '../src/core/analyzer.js'
import { sharedDb } from '../src/incremental/database.js'
import { clearMtimeCache, clearInputSignatures } from '../src/incremental/queries.js'
import { resetProjectCache } from '../src/incremental/project-cache.js'
import { allPackageDeps } from '../src/incremental/package-deps.js'

let root: string

const INDEX_TS = `// @ts-nocheck
// N'importe PAS 'unused-dep' → declared-unused attendu.
export function hello(): string {
  return 'hi'
}
`

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'inc-pkgdeps-'))
  await mkdir(path.join(root, 'src'), { recursive: true })
  await writeFile(path.join(root, 'src', 'index.ts'), INDEX_TS)
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-pkg', dependencies: { 'unused-dep': '^1.0.0' } }),
  )
  await writeFile(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ES2022', strict: false },
      include: ['src/**/*.ts'],
    }),
  )
})

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

describe('incremental package-deps — allPackageDeps', () => {
  it('détecte une dep déclarée mais jamais importée', async () => {
    const config = {
      rootDir: root,
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts'],
      entryPoints: ['src/index.ts'],
      tsconfigPath: 'tsconfig.json',
    }

    sharedDb.resetState()
    clearMtimeCache()
    clearInputSignatures()
    resetProjectCache()

    await analyze(config, {
      incremental: true,
      skipPersistenceLoad: true,
      skipPersistenceSave: true,
    })

    const issues = allPackageDeps.get('all')
    const unused = issues
      .filter((i) => i.kind === 'declared-unused')
      .map((i) => i.packageName)
    expect(unused).toContain('unused-dep')
  })
})
