/**
 * Tests pour la détection de patterns (singleton). Pure unit, sans LLM.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { detectSingletonCandidates } from '../src/bootstrap.js'
import type { AdrToolkitConfig } from '../src/config.js'

let fixtureRoot: string

beforeAll(async () => {
  fixtureRoot = await mkdtemp(path.join(tmpdir(), 'bootstrap-detect-'))
  await mkdir(path.join(fixtureRoot, 'src'), { recursive: true })

  // Fichier 1 : singleton classique → match
  await writeFile(
    path.join(fixtureRoot, 'src/manager.ts'),
    `
export class Manager {
  private static instance: Manager
  private constructor() {}
  static getInstance(): Manager {
    if (!Manager.instance) Manager.instance = new Manager()
    return Manager.instance
  }
}
`,
    'utf-8',
  )

  // Fichier 2 : singleton avec readonly → match
  await writeFile(
    path.join(fixtureRoot, 'src/queue.ts'),
    `
class Queue {
  static readonly instance = new Queue()
}
`,
    'utf-8',
  )

  // Fichier 3 : pas un singleton → skip
  await writeFile(
    path.join(fixtureRoot, 'src/util.ts'),
    `
export function add(a: number, b: number): number { return a + b }
`,
    'utf-8',
  )

  // Fichier 4 : "instance" mais pas static → skip (faux ami)
  await writeFile(
    path.join(fixtureRoot, 'src/notSingleton.ts'),
    `
export class Foo {
  private instance: number = 0
  setInstance(v: number) { this.instance = v }
}
`,
    'utf-8',
  )
})

afterAll(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true })
})

describe('detectSingletonCandidates', () => {
  it('détecte un singleton classique (private static instance + getInstance)', async () => {
    const config = mockConfig(fixtureRoot)
    const files = ['src/manager.ts', 'src/queue.ts', 'src/util.ts', 'src/notSingleton.ts']
    const candidates = await detectSingletonCandidates(config, files)
    const paths = candidates.map(c => c.relativePath).sort()
    expect(paths).toContain('src/manager.ts')
  })

  it('détecte aussi le pattern static readonly instance', async () => {
    const config = mockConfig(fixtureRoot)
    const files = ['src/queue.ts']
    const candidates = await detectSingletonCandidates(config, files)
    expect(candidates.length).toBe(1)
    expect(candidates[0].relativePath).toBe('src/queue.ts')
  })

  it('exclut les non-singletons', async () => {
    const config = mockConfig(fixtureRoot)
    const files = ['src/util.ts', 'src/notSingleton.ts']
    const candidates = await detectSingletonCandidates(config, files)
    expect(candidates).toEqual([])
  })

  it('inclut une evidence avec ligne + texte', async () => {
    const config = mockConfig(fixtureRoot)
    const files = ['src/manager.ts']
    const candidates = await detectSingletonCandidates(config, files)
    expect(candidates[0].evidence).toMatch(/^line \d+:/)
    expect(candidates[0].evidence).toContain('static instance')
  })
})

function mockConfig(rootDir: string): AdrToolkitConfig {
  return {
    rootDir,
    adrDir: 'docs/adr',
    srcDirs: ['src'],
    tsconfigPath: 'tsconfig.json',
    briefPath: 'CLAUDE-CONTEXT.md',
    anchorMarkerExtensions: ['ts', 'tsx', 'sh', 'sql'],
    skipDirs: ['node_modules', 'dist', '.git'],
    hubThreshold: 15,
    invariantTestPaths: [],
    briefCustomSections: [],
  }
}
