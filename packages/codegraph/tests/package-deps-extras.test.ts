/**
 * Tests des helpers internes de `extractors/package-deps.ts` ajoutes lors
 * des batchs P2 / Janus F-005 :
 *   - isBuildTimeDep : whitelist build-time tools (typescript, eslint, ...)
 *   - collectWorkspaceNames : noms de tous les workspaces locaux
 *   - collectPackagesWithBin : packages avec un `bin` field dans node_modules
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  isBuildTimeDep,
  collectWorkspaceNames,
  collectPackagesWithBin,
  type PackageManifest,
} from '../src/extractors/package-deps.js'

let TMP_ROOT = ''

beforeAll(async () => {
  TMP_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'codegraph-pkgdeps-test-'))
})

afterAll(async () => {
  if (TMP_ROOT) await fs.rm(TMP_ROOT, { recursive: true, force: true })
})

// ─── isBuildTimeDep ────────────────────────────────────────────────────────

describe('isBuildTimeDep', () => {
  it('match les type-checkers et linters', () => {
    expect(isBuildTimeDep('typescript')).toBe(true)
    expect(isBuildTimeDep('eslint')).toBe(true)
    expect(isBuildTimeDep('prettier')).toBe(true)
    expect(isBuildTimeDep('biome')).toBe(true)
    expect(isBuildTimeDep('@biomejs/biome')).toBe(true)
  })

  it('match les test runners', () => {
    expect(isBuildTimeDep('vitest')).toBe(true)
    expect(isBuildTimeDep('jest')).toBe(true)
    expect(isBuildTimeDep('mocha')).toBe(true)
  })

  it('match les bundlers', () => {
    expect(isBuildTimeDep('tsup')).toBe(true)
    expect(isBuildTimeDep('tsx')).toBe(true)
    expect(isBuildTimeDep('tsdown')).toBe(true)
    expect(isBuildTimeDep('rollup')).toBe(true)
    expect(isBuildTimeDep('esbuild')).toBe(true)
    expect(isBuildTimeDep('webpack')).toBe(true)
    expect(isBuildTimeDep('vite')).toBe(true)
  })

  it('match les monorepo tools', () => {
    expect(isBuildTimeDep('turbo')).toBe(true)
    expect(isBuildTimeDep('lerna')).toBe(true)
    expect(isBuildTimeDep('nx')).toBe(true)
    expect(isBuildTimeDep('@changesets/cli')).toBe(true)
  })

  it('match prefix @types/', () => {
    expect(isBuildTimeDep('@types/node')).toBe(true)
    expect(isBuildTimeDep('@types/react')).toBe(true)
    expect(isBuildTimeDep('@types/express')).toBe(true)
  })

  it('match prefix eslint-config- / eslint-plugin-', () => {
    expect(isBuildTimeDep('eslint-config-prettier')).toBe(true)
    expect(isBuildTimeDep('eslint-plugin-react')).toBe(true)
  })

  it('match prefix prettier-plugin-', () => {
    expect(isBuildTimeDep('prettier-plugin-tailwindcss')).toBe(true)
  })

  it('match prefix @typescript-eslint/', () => {
    expect(isBuildTimeDep('@typescript-eslint/parser')).toBe(true)
    expect(isBuildTimeDep('@typescript-eslint/eslint-plugin')).toBe(true)
  })

  it('match @cloudflare/workers-types (Janus F-005)', () => {
    expect(isBuildTimeDep('@cloudflare/workers-types')).toBe(true)
  })

  it('does NOT match les runtime deps', () => {
    expect(isBuildTimeDep('react')).toBe(false)
    expect(isBuildTimeDep('lodash')).toBe(false)
    expect(isBuildTimeDep('@trpc/server')).toBe(false)
    expect(isBuildTimeDep('next')).toBe(false)
    expect(isBuildTimeDep('zod')).toBe(false)
    expect(isBuildTimeDep('graphology')).toBe(false)
  })

  it('does NOT match les fragments qui contiennent un nom build-time', () => {
    expect(isBuildTimeDep('typescript-eslint')).toBe(false)  // pas typescript pur
    expect(isBuildTimeDep('eslint-cool-runtime')).toBe(false)  // pas un prefix
    expect(isBuildTimeDep('my-vite-plugin')).toBe(false)
  })
})

// ─── collectWorkspaceNames ─────────────────────────────────────────────────

describe('collectWorkspaceNames', () => {
  function fakeManifest(name: string, dir = ''): PackageManifest {
    return {
      abs: `/fake/${dir}/package.json`,
      rel: `${dir}/package.json`,
      dir: `/fake/${dir}`,
      packageName: name,
      declared: new Map(),
      scriptsText: '',
    }
  }

  it('collecte les noms de tous les manifests', () => {
    const set = collectWorkspaceNames([
      fakeManifest('@x/server', 'packages/server'),
      fakeManifest('@x/client', 'packages/client'),
      fakeManifest('@x/middleware', 'packages/middleware'),
    ])
    expect(set.size).toBe(3)
    expect(set.has('@x/server')).toBe(true)
    expect(set.has('@x/client')).toBe(true)
  })

  it('skip les manifests sans packageName', () => {
    const m: PackageManifest = {
      abs: '/fake/package.json', rel: 'package.json', dir: '/fake',
      packageName: '', declared: new Map(), scriptsText: '',
    }
    const set = collectWorkspaceNames([m])
    expect(set.size).toBe(0)
  })

  it('returns empty Set pour liste vide', () => {
    expect(collectWorkspaceNames([]).size).toBe(0)
  })
})

// ─── collectPackagesWithBin ────────────────────────────────────────────────

describe('collectPackagesWithBin', () => {
  it('detect packages avec bin field via node_modules lookup', async () => {
    const root = path.join(TMP_ROOT, 'bin-detect')
    await fs.mkdir(root, { recursive: true })
    // Setup node_modules/<pkg>/package.json fixtures
    await fs.mkdir(path.join(root, 'node_modules/cli-tool'), { recursive: true })
    await fs.writeFile(
      path.join(root, 'node_modules/cli-tool/package.json'),
      JSON.stringify({ name: 'cli-tool', bin: { 'cli-tool': './bin/cli.js' } }),
    )
    await fs.mkdir(path.join(root, 'node_modules/regular-lib'), { recursive: true })
    await fs.writeFile(
      path.join(root, 'node_modules/regular-lib/package.json'),
      JSON.stringify({ name: 'regular-lib', main: './dist/index.js' }),
    )

    // Manifest declarant les deux deps
    const manifest: PackageManifest = {
      abs: path.join(root, 'package.json'),
      rel: 'package.json',
      dir: root,
      packageName: 'consumer',
      declared: new Map([
        ['cli-tool', 'devDependencies'],
        ['regular-lib', 'dependencies'],
      ]),
      scriptsText: '',
    }

    const set = await collectPackagesWithBin(root, [manifest])
    expect(set.has('cli-tool')).toBe(true)
    expect(set.has('regular-lib')).toBe(false)
  })

  it('returns empty Set quand node_modules absent', async () => {
    const root = path.join(TMP_ROOT, 'no-nm')
    await fs.mkdir(root, { recursive: true })
    const manifest: PackageManifest = {
      abs: path.join(root, 'package.json'),
      rel: 'package.json',
      dir: root,
      packageName: 'consumer',
      declared: new Map([['lodash', 'dependencies']]),
      scriptsText: '',
    }
    const set = await collectPackagesWithBin(root, [manifest])
    expect(set.size).toBe(0)
  })

  it('detect bin field en string (vs object)', async () => {
    const root = path.join(TMP_ROOT, 'bin-string')
    await fs.mkdir(path.join(root, 'node_modules/single-bin'), { recursive: true })
    await fs.writeFile(
      path.join(root, 'node_modules/single-bin/package.json'),
      JSON.stringify({ name: 'single-bin', bin: './cli.js' }),  // string form
    )

    const manifest: PackageManifest = {
      abs: path.join(root, 'package.json'),
      rel: 'package.json',
      dir: root,
      packageName: 'consumer',
      declared: new Map([['single-bin', 'dependencies']]),
      scriptsText: '',
    }

    const set = await collectPackagesWithBin(root, [manifest])
    expect(set.has('single-bin')).toBe(true)
  })

  it('aggregates declared deps from multiple manifests (monorepo)', async () => {
    const root = path.join(TMP_ROOT, 'multi-manifest')
    await fs.mkdir(path.join(root, 'node_modules/codegraph'), { recursive: true })
    await fs.writeFile(
      path.join(root, 'node_modules/codegraph/package.json'),
      JSON.stringify({ name: 'codegraph', bin: { codegraph: './dist/cli/index.js' } }),
    )

    const root_manifest: PackageManifest = {
      abs: path.join(root, 'package.json'),
      rel: 'package.json',
      dir: root,
      packageName: 'monorepo-root',
      declared: new Map([['codegraph', 'devDependencies']]),
      scriptsText: '',
    }
    const sub_manifest: PackageManifest = {
      abs: path.join(root, 'packages/sub/package.json'),
      rel: 'packages/sub/package.json',
      dir: path.join(root, 'packages/sub'),
      packageName: '@x/sub',
      declared: new Map([['codegraph', 'dependencies']]),  // duplicate, OK
      scriptsText: '',
    }

    const set = await collectPackagesWithBin(root, [root_manifest, sub_manifest])
    expect(set.has('codegraph')).toBe(true)
  })
})
