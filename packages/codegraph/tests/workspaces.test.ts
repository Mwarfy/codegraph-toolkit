/**
 * Tests du module `core/workspaces.ts` (P2 — workspace detection).
 *
 * Couvre les comportements critiques :
 *   - Parser pnpm-workspace.yaml minimal
 *   - Glob expand `packages/*` ET `packages/**\/*`
 *   - Detection multi-source (pnpm > package.json#workspaces > lerna.json)
 *   - workspaceEntryFiles avec mapping src↔dist
 *   - buildWorkspaceEntryPointSet integration
 *
 * Strategie : fixtures filesystem temporaires sous /tmp pour
 * `detectWorkspaces`, et tests purs pour les helpers exposes.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  detectWorkspaces,
  workspaceEntryFiles,
  buildWorkspaceEntryPointSet,
  type WorkspaceEntry,
} from '../src/core/workspaces.js'

let TMP_ROOT = ''

beforeAll(async () => {
  TMP_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'codegraph-workspaces-test-'))
})

afterAll(async () => {
  if (TMP_ROOT) await fs.rm(TMP_ROOT, { recursive: true, force: true })
})

async function makeFixture(rel: string, content: string): Promise<void> {
  const abs = path.join(TMP_ROOT, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content)
}

async function makeDir(rel: string): Promise<void> {
  await fs.mkdir(path.join(TMP_ROOT, rel), { recursive: true })
}

describe('detectWorkspaces — pnpm-workspace.yaml', () => {
  it('returns empty pour un repo sans config workspace', async () => {
    const dir = path.join(TMP_ROOT, 'no-workspace')
    await makeDir(`no-workspace`)
    await makeFixture('no-workspace/package.json', JSON.stringify({ name: 'solo' }))
    const map = await detectWorkspaces(dir)
    expect(map.byName.size).toBe(0)
    expect(map.paths).toEqual([])
  })

  it('parse pnpm-workspace.yaml avec packages/*', async () => {
    const dir = path.join(TMP_ROOT, 'pnpm-simple')
    await makeFixture(`pnpm-simple/pnpm-workspace.yaml`, `packages:\n  - 'packages/*'\n`)
    await makeFixture(`pnpm-simple/packages/foo/package.json`,
      JSON.stringify({ name: '@scope/foo', main: './src/index.ts' }))
    await makeFixture(`pnpm-simple/packages/bar/package.json`,
      JSON.stringify({ name: '@scope/bar', main: './src/index.ts' }))
    const map = await detectWorkspaces(dir)
    expect(map.byName.size).toBe(2)
    expect(map.byName.has('@scope/foo')).toBe(true)
    expect(map.byName.has('@scope/bar')).toBe(true)
    expect(map.paths.sort()).toEqual(['packages/bar', 'packages/foo'])
  })

  it('parse pnpm-workspace.yaml avec packages/**\/* (recursif)', async () => {
    const dir = path.join(TMP_ROOT, 'pnpm-nested')
    await makeFixture(`pnpm-nested/pnpm-workspace.yaml`, `packages:\n  - 'packages/**/*'\n`)
    await makeFixture(`pnpm-nested/packages/server/package.json`,
      JSON.stringify({ name: '@x/server' }))
    await makeFixture(`pnpm-nested/packages/middleware/express/package.json`,
      JSON.stringify({ name: '@x/express' }))
    await makeFixture(`pnpm-nested/packages/middleware/hono/package.json`,
      JSON.stringify({ name: '@x/hono' }))
    const map = await detectWorkspaces(dir)
    expect(map.byName.size).toBe(3)
    expect(map.byName.has('@x/server')).toBe(true)
    expect(map.byName.has('@x/express')).toBe(true)
    expect(map.byName.has('@x/hono')).toBe(true)
  })

  it('parse pnpm-workspace.yaml avec indentation 4 espaces (mcp-sdk style)', async () => {
    const dir = path.join(TMP_ROOT, 'pnpm-4spaces')
    await makeFixture(`pnpm-4spaces/pnpm-workspace.yaml`,
      `packages:\n    - packages/**/*\n    - common/**/*\n`)
    await makeFixture(`pnpm-4spaces/packages/core/package.json`,
      JSON.stringify({ name: '@x/core' }))
    await makeFixture(`pnpm-4spaces/common/eslint-config/package.json`,
      JSON.stringify({ name: '@x/eslint-config' }))
    const map = await detectWorkspaces(dir)
    expect(map.byName.size).toBe(2)
  })

  it('skip les patterns avec "!" (exclusions)', async () => {
    const dir = path.join(TMP_ROOT, 'pnpm-excl')
    await makeFixture(`pnpm-excl/pnpm-workspace.yaml`,
      `packages:\n  - 'packages/*'\n  - '!**/test/**'\n`)
    await makeFixture(`pnpm-excl/packages/a/package.json`,
      JSON.stringify({ name: '@x/a' }))
    const map = await detectWorkspaces(dir)
    expect(map.byName.size).toBe(1)
  })

  it('skip node_modules quand parcourt par glob', async () => {
    const dir = path.join(TMP_ROOT, 'pnpm-nm')
    await makeFixture(`pnpm-nm/pnpm-workspace.yaml`, `packages:\n  - 'packages/*'\n`)
    await makeFixture(`pnpm-nm/packages/a/package.json`, JSON.stringify({ name: '@x/a' }))
    await makeFixture(`pnpm-nm/packages/node_modules/decoy/package.json`,
      JSON.stringify({ name: 'should-not-be-detected' }))
    const map = await detectWorkspaces(dir)
    expect(map.byName.has('@x/a')).toBe(true)
    expect(map.byName.has('should-not-be-detected')).toBe(false)
  })
})

describe('detectWorkspaces — package.json#workspaces', () => {
  it('parse npm/yarn workspaces (array form)', async () => {
    const dir = path.join(TMP_ROOT, 'npm-ws')
    await makeFixture(`npm-ws/package.json`, JSON.stringify({
      name: 'root',
      workspaces: ['packages/*'],
    }))
    await makeFixture(`npm-ws/packages/a/package.json`, JSON.stringify({ name: '@x/a' }))
    await makeFixture(`npm-ws/packages/b/package.json`, JSON.stringify({ name: '@x/b' }))
    const map = await detectWorkspaces(dir)
    expect(map.byName.size).toBe(2)
  })

  it('parse yarn berry (object form avec packages)', async () => {
    const dir = path.join(TMP_ROOT, 'yarn-berry')
    await makeFixture(`yarn-berry/package.json`, JSON.stringify({
      name: 'root',
      workspaces: { packages: ['apps/*', 'libs/*'] },
    }))
    await makeFixture(`yarn-berry/apps/web/package.json`, JSON.stringify({ name: '@x/web' }))
    await makeFixture(`yarn-berry/libs/utils/package.json`, JSON.stringify({ name: '@x/utils' }))
    const map = await detectWorkspaces(dir)
    expect(map.byName.size).toBe(2)
    expect(map.byName.has('@x/web')).toBe(true)
    expect(map.byName.has('@x/utils')).toBe(true)
  })
})

describe('detectWorkspaces — lerna.json', () => {
  it('parse lerna.json#packages', async () => {
    const dir = path.join(TMP_ROOT, 'lerna')
    await makeFixture(`lerna/lerna.json`, JSON.stringify({ packages: ['packages/*'] }))
    await makeFixture(`lerna/packages/a/package.json`, JSON.stringify({ name: '@x/a' }))
    const map = await detectWorkspaces(dir)
    expect(map.byName.size).toBe(1)
  })
})

describe('detectWorkspaces — priority pnpm > package.json > lerna', () => {
  it('pnpm config gagne quand les 3 sont presents', async () => {
    const dir = path.join(TMP_ROOT, 'priority')
    // pnpm dit packages/*
    await makeFixture(`priority/pnpm-workspace.yaml`, `packages:\n  - 'packages/*'\n`)
    // package.json dit apps/* (mais pnpm gagne)
    await makeFixture(`priority/package.json`, JSON.stringify({ workspaces: ['apps/*'] }))
    await makeFixture(`priority/lerna.json`, JSON.stringify({ packages: ['libs/*'] }))
    await makeFixture(`priority/packages/a/package.json`, JSON.stringify({ name: '@x/a' }))
    await makeFixture(`priority/apps/x/package.json`, JSON.stringify({ name: '@x/decoy-app' }))
    const map = await detectWorkspaces(dir)
    expect(map.byName.has('@x/a')).toBe(true)
    expect(map.byName.has('@x/decoy-app')).toBe(false)
  })
})

// ─── workspaceEntryFiles (pure helper) ─────────────────────────────────────

describe('workspaceEntryFiles', () => {
  it('inclut les conventions fallback meme sans champ explicite', () => {
    const ws: WorkspaceEntry = { name: '@x/a', relPath: 'packages/a' }
    const files = workspaceEntryFiles(ws)
    expect(files).toContain('packages/a/index.ts')
    expect(files).toContain('packages/a/index.tsx')
    expect(files).toContain('packages/a/src/index.ts')
    expect(files).toContain('packages/a/src/index.tsx')
  })

  it('inclut le champ main et strip "./"', () => {
    const ws: WorkspaceEntry = { name: '@x/a', relPath: 'packages/a', main: './src/main.ts' }
    const files = workspaceEntryFiles(ws)
    expect(files).toContain('packages/a/src/main.ts')
  })

  it('inclut le champ types', () => {
    const ws: WorkspaceEntry = { name: '@x/a', relPath: 'packages/a', types: 'src/types.ts' }
    const files = workspaceEntryFiles(ws)
    expect(files).toContain('packages/a/src/types.ts')
  })

  it('inclut bin (string et map)', () => {
    const ws1: WorkspaceEntry = { name: '@x/a', relPath: 'packages/a', bin: 'bin/cli.ts' }
    expect(workspaceEntryFiles(ws1)).toContain('packages/a/bin/cli.ts')
    const ws2: WorkspaceEntry = {
      name: '@x/b', relPath: 'packages/b',
      bin: { foo: 'bin/foo.ts', bar: 'bin/bar.ts' },
    }
    const files = workspaceEntryFiles(ws2)
    expect(files).toContain('packages/b/bin/foo.ts')
    expect(files).toContain('packages/b/bin/bar.ts')
  })

  it('inclut exports (string)', () => {
    const ws: WorkspaceEntry = {
      name: '@x/a', relPath: 'packages/a',
      exports: './src/index.ts',
    }
    const files = workspaceEntryFiles(ws)
    expect(files).toContain('packages/a/src/index.ts')
  })

  it('inclut exports (object recursif avec conditions)', () => {
    const ws: WorkspaceEntry = {
      name: '@x/a', relPath: 'packages/a',
      exports: {
        '.': { import: './src/index.ts', types: './src/index.d.ts' },
        './sub': { browser: './src/browser.ts', node: './src/node.ts' },
      },
    }
    const files = workspaceEntryFiles(ws)
    expect(files).toContain('packages/a/src/index.ts')
    expect(files).toContain('packages/a/src/browser.ts')
    expect(files).toContain('packages/a/src/node.ts')
  })

  it('mappe dist/X.mjs vers src/X.ts (mcp-sdk pattern)', () => {
    const ws: WorkspaceEntry = {
      name: '@x/client', relPath: 'packages/client',
      exports: {
        '.': { import: './dist/index.mjs', types: './dist/index.d.mts' },
      },
    }
    const files = workspaceEntryFiles(ws)
    expect(files).toContain('packages/client/src/index.ts')
  })

  it('mappe dist/shimsBrowser.mjs vers src/shimsBrowser.ts', () => {
    const ws: WorkspaceEntry = {
      name: '@x/client', relPath: 'packages/client',
      exports: {
        './_shims': {
          browser: { import: './dist/shimsBrowser.mjs' },
          node: { import: './dist/shimsNode.mjs' },
        },
      },
    }
    const files = workspaceEntryFiles(ws)
    expect(files).toContain('packages/client/src/shimsBrowser.ts')
    expect(files).toContain('packages/client/src/shimsNode.ts')
  })

  it('genere les variantes d extension (.js → .ts/.tsx)', () => {
    const ws: WorkspaceEntry = {
      name: '@x/a', relPath: 'packages/a', main: './lib/foo.js',
    }
    const files = workspaceEntryFiles(ws)
    // src/foo.ts via dist→src remap
    expect(files).toContain('packages/a/src/foo.ts')
    // pas src/foo.tsx parce que .js → .ts/.tsx priorise .ts
    expect(files.some((f) => f.endsWith('foo.tsx'))).toBe(true)
  })
})

// ─── buildWorkspaceEntryPointSet ────────────────────────────────────────────

describe('buildWorkspaceEntryPointSet', () => {
  it('construit un Set deduplique a partir d une WorkspaceMap', () => {
    const map = {
      byName: new Map<string, WorkspaceEntry>([
        ['@x/a', { name: '@x/a', relPath: 'packages/a', main: './src/index.ts' }],
        ['@x/b', { name: '@x/b', relPath: 'packages/b', main: './src/index.ts' }],
      ]),
      paths: ['packages/a', 'packages/b'],
    }
    const set = buildWorkspaceEntryPointSet(map)
    expect(set.has('packages/a/src/index.ts')).toBe(true)
    expect(set.has('packages/b/src/index.ts')).toBe(true)
    // Conventions fallback aussi presentes
    expect(set.has('packages/a/index.ts')).toBe(true)
  })

  it('retourne un Set vide pour une map vide', () => {
    const set = buildWorkspaceEntryPointSet({ byName: new Map(), paths: [] })
    expect(set.size).toBe(0)
  })
})
