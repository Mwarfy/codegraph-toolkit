/**
 * Tests pour la détection de FSM (unions string literals + writes observables).
 * Pure unit, sans LLM. Fixtures écrites en tmpdir.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { detectFsmCandidates } from '../src/bootstrap-fsm.js'
import type { AdrToolkitConfig } from '../src/config.js'

let fixtureRoot: string

beforeAll(async () => {
  fixtureRoot = await mkdtemp(path.join(tmpdir(), 'bootstrap-fsm-'))
  await mkdir(path.join(fixtureRoot, 'src'), { recursive: true })

  // Fichier 1 : FSM positive avec writes (object literal + assignment)
  await writeFile(
    path.join(fixtureRoot, 'src/positive-strict.ts'),
    `
export type BlockStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface Block {
  id: string
  status: BlockStatus
}

export function createBlock(id: string): Block {
  return { id, status: 'pending' }
}

export function start(b: Block): void {
  b.status = 'running'
}

export function finish(b: Block, ok: boolean): void {
  b.status = ok ? 'completed' : 'failed'
}
`,
    'utf-8',
  )

  // Fichier 2 : suffix match mais pas une union de literals → skip
  await writeFile(
    path.join(fixtureRoot, 'src/negative-suffix-not-fsm.ts'),
    `
export interface ConsoleState {
  logs: string[]
  level: number
}

export type ResultState<T> = { ok: T } | { err: Error }
`,
    'utf-8',
  )

  // Fichier 3 : numeric enum → skip (sémantique différente)
  await writeFile(
    path.join(fixtureRoot, 'src/negative-numeric-enum.ts'),
    `
export enum NumericStatus {
  PENDING,
  RUNNING,
  COMPLETED,
}
`,
    'utf-8',
  )

  // Fichier 4 : FSM mais pas de writes observés → match mais writeSites=[]
  await writeFile(
    path.join(fixtureRoot, 'src/limit-no-writes.ts'),
    `
export type DeployPhase = 'init' | 'build' | 'deploy'
`,
    'utf-8',
  )

  // Fichier 5 : string enum → match
  await writeFile(
    path.join(fixtureRoot, 'src/string-enum.ts'),
    `
export enum JobPhase {
  INIT = 'init',
  RUNNING = 'running',
  DONE = 'done',
}

export function setPhase(j: { phase: JobPhase }): void {
  j.phase = JobPhase.RUNNING
}
`,
    'utf-8',
  )

  // Fichier 6 : valeur non-FSM ne doit PAS apparaître en writeSites
  // (ex: 'ok' dans un { status: 'ok' } sans que 'ok' soit dans la FSM)
  await writeFile(
    path.join(fixtureRoot, 'src/cross-ref-filter.ts'),
    `
export type RequestState = 'idle' | 'loading' | 'success' | 'error'

export function reset(r: { status: string }): void {
  // 'ok' n'est PAS dans la FSM RequestState — ne doit pas matcher
  r.status = 'ok'
}

export function start(r: { status: RequestState }): void {
  r.status = 'loading'
}
`,
    'utf-8',
  )
})

afterAll(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true })
})

describe('detectFsmCandidates', () => {
  it('détecte une FSM avec values + writeSites (object literal + assignment)', () => {
    const config = mockConfig(fixtureRoot)
    const candidates = detectFsmCandidates(config, ['src/positive-strict.ts'])

    expect(candidates).toHaveLength(1)
    const c = candidates[0]
    expect(c.kind).toBe('fsm')
    expect(c.fsmName).toBe('BlockStatus')
    expect(c.values).toEqual(['pending', 'running', 'completed', 'failed'])
    // 4 writes : { status: 'pending' }, b.status = 'running',
    // b.status = 'completed', b.status = 'failed'
    expect(c.writeSites.length).toBeGreaterThanOrEqual(2)

    // Le write 'pending' (object literal dans createBlock) doit avoir
    // trigger=createBlock
    const pending = c.writeSites.find(s => s.value === 'pending')
    expect(pending).toBeDefined()
    expect(pending?.trigger).toBe('createBlock')

    // Le write 'running' (assignment dans start) doit avoir trigger=start
    const running = c.writeSites.find(s => s.value === 'running')
    expect(running).toBeDefined()
    expect(running?.trigger).toBe('start')
  })

  it('skip suffix match sans union de string literals', () => {
    const config = mockConfig(fixtureRoot)
    const candidates = detectFsmCandidates(config, ['src/negative-suffix-not-fsm.ts'])
    expect(candidates).toEqual([])
  })

  it('skip numeric enums (pas la sémantique FSM)', () => {
    const config = mockConfig(fixtureRoot)
    const candidates = detectFsmCandidates(config, ['src/negative-numeric-enum.ts'])
    expect(candidates).toEqual([])
  })

  it('détecte la FSM même sans writes (writeSites vide)', () => {
    const config = mockConfig(fixtureRoot)
    const candidates = detectFsmCandidates(config, ['src/limit-no-writes.ts'])
    expect(candidates).toHaveLength(1)
    expect(candidates[0].fsmName).toBe('DeployPhase')
    expect(candidates[0].values).toEqual(['init', 'build', 'deploy'])
    expect(candidates[0].writeSites).toEqual([])
  })

  it('détecte les string enums (members avec initializer string)', () => {
    const config = mockConfig(fixtureRoot)
    const candidates = detectFsmCandidates(config, ['src/string-enum.ts'])
    expect(candidates).toHaveLength(1)
    expect(candidates[0].fsmName).toBe('JobPhase')
    expect(candidates[0].values).toEqual(['init', 'running', 'done'])
  })

  it('cross-ref filter : valeurs hors-FSM ne polluent pas writeSites', () => {
    const config = mockConfig(fixtureRoot)
    const candidates = detectFsmCandidates(config, ['src/cross-ref-filter.ts'])
    expect(candidates).toHaveLength(1)
    const c = candidates[0]
    expect(c.fsmName).toBe('RequestState')
    // Doit contenir 'loading' mais PAS 'ok'
    const values = c.writeSites.map(s => s.value)
    expect(values).toContain('loading')
    expect(values).not.toContain('ok')
  })

  it('produit une evidence lisible avec name + line + count', () => {
    const config = mockConfig(fixtureRoot)
    const candidates = detectFsmCandidates(config, ['src/positive-strict.ts'])
    expect(candidates[0].evidence).toMatch(/^type BlockStatus \(line \d+\):/)
    expect(candidates[0].evidence).toContain('pending | running')
    expect(candidates[0].evidence).toMatch(/\d+ write site\(s\)/)
  })
})

function mockConfig(rootDir: string): AdrToolkitConfig {
  return {
    rootDir,
    adrDir: 'docs/adr',
    srcDirs: ['src'],
    tsconfigPath: undefined as unknown as string,  // pas de tsconfig dans les fixtures
    briefPath: 'CLAUDE-CONTEXT.md',
    anchorMarkerExtensions: ['ts', 'tsx', 'sh', 'sql'],
    skipDirs: ['node_modules', 'dist', '.git'],
    hubThreshold: 15,
    invariantTestPaths: [],
    briefCustomSections: [],
  }
}
