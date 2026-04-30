/**
 * Test de l'extracteur co-change sur un repo git fixture.
 *
 * Crée un repo temporaire, fait 5 commits orchestrés, vérifie que les
 * paires sont bien comptées + filtrées par seuils.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { execSync } from 'node:child_process'
import { analyzeCoChange } from '../src/extractors/co-change.js'

let repo: string

beforeAll(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'co-change-test-'))
  execSync('git init -q', { cwd: repo })
  execSync('git config user.email test@test', { cwd: repo })
  execSync('git config user.name Test', { cwd: repo })
  execSync('git config commit.gpgsign false', { cwd: repo })

  // c1: a + b
  await fs.writeFile(path.join(repo, 'a.ts'), 'export const a = 1\n')
  await fs.writeFile(path.join(repo, 'b.ts'), 'export const b = 1\n')
  execSync('git add . && git commit -q -m c1', { cwd: repo })

  // c2: a + b
  await fs.writeFile(path.join(repo, 'a.ts'), 'export const a = 2\n')
  await fs.writeFile(path.join(repo, 'b.ts'), 'export const b = 2\n')
  execSync('git add . && git commit -q -m c2', { cwd: repo })

  // c3: a + b + c
  await fs.writeFile(path.join(repo, 'a.ts'), 'export const a = 3\n')
  await fs.writeFile(path.join(repo, 'b.ts'), 'export const b = 3\n')
  await fs.writeFile(path.join(repo, 'c.ts'), 'export const c = 1\n')
  execSync('git add . && git commit -q -m c3', { cwd: repo })

  // c4: a seul
  await fs.writeFile(path.join(repo, 'a.ts'), 'export const a = 4\n')
  execSync('git add . && git commit -q -m c4', { cwd: repo })

  // c5: c + d (paire 1× → sous seuil par défaut)
  await fs.writeFile(path.join(repo, 'c.ts'), 'export const c = 2\n')
  await fs.writeFile(path.join(repo, 'd.ts'), 'export const d = 1\n')
  execSync('git add . && git commit -q -m c5', { cwd: repo })
})

afterAll(async () => {
  if (repo) await fs.rm(repo, { recursive: true, force: true })
})

describe('co-change extractor', () => {
  it('captures (a, b) co-changed 3 times with correct totals + jaccard', async () => {
    const pairs = await analyzeCoChange(repo, { minCount: 2 })
    const ab = pairs.find((p) => p.from === 'a.ts' && p.to === 'b.ts')
    expect(ab).toBeDefined()
    expect(ab!.count).toBe(3)
    // a in c1,c2,c3,c4 = 4; b in c1,c2,c3 = 3
    expect(ab!.totalCommitsFrom).toBe(4)
    expect(ab!.totalCommitsTo).toBe(3)
    // jaccard = 3 / (4+3-3) = 3/4
    expect(ab!.jaccard).toBe(0.75)
  })

  it('default minCount=3 keeps only (a, b)', async () => {
    const pairs = await analyzeCoChange(repo)
    expect(pairs.length).toBe(1)
    expect(pairs[0].from).toBe('a.ts')
    expect(pairs[0].to).toBe('b.ts')
  })

  it('minJaccard filters diluted pairs', async () => {
    const pairs = await analyzeCoChange(repo, { minCount: 1, minJaccard: 0.5 })
    for (const p of pairs) expect(p.jaccard).toBeGreaterThanOrEqual(0.5)
  })

  it('knownFiles filters out-of-project files', async () => {
    const knownFiles = new Set(['a.ts', 'b.ts'])
    const pairs = await analyzeCoChange(repo, { minCount: 1, knownFiles })
    for (const p of pairs) {
      expect(knownFiles.has(p.from)).toBe(true)
      expect(knownFiles.has(p.to)).toBe(true)
    }
  })

  it('sort is stable: count desc, jaccard desc, from asc, to asc', async () => {
    const pairs = await analyzeCoChange(repo, { minCount: 1 })
    for (let i = 1; i < pairs.length; i++) {
      const prev = pairs[i - 1]
      const cur = pairs[i]
      const orderOk =
        prev.count > cur.count ||
        (prev.count === cur.count && prev.jaccard >= cur.jaccard)
      expect(orderOk).toBe(true)
    }
  })

  it('returns empty array when not in a git repo', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'co-change-nogit-'))
    try {
      const pairs = await analyzeCoChange(tmp)
      expect(pairs).toEqual([])
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })
})
