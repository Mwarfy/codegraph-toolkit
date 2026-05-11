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

  it('knownFiles filters out-of-project pairs (OR semantics — at least one known)', async () => {
    // SEMANTIC CHANGE (bug #1 fix) : avant, la pair n'était émise que si les
    // 2 côtés étaient dans knownFiles (strict AND). Cassait les paires
    // test↔source sur projets où les tests sont exclus du glob (Hono : *.test.tsx).
    // Maintenant : pair émise si AU MOINS UN côté est known. Permet de garder
    // les paires test→source légitimes tout en filtrant les paires
    // entièrement hors-projet (README↔CHANGELOG).
    const knownFiles = new Set(['a.ts', 'b.ts'])
    const pairs = await analyzeCoChange(repo, { minCount: 1, knownFiles })
    for (const p of pairs) {
      const atLeastOneKnown = knownFiles.has(p.from) || knownFiles.has(p.to)
      expect(atLeastOneKnown, `pair ${p.from} ↔ ${p.to} has no known side`).toBe(true)
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

  // ADR-029 — vues dérivées tracked dans l'historique mais désormais
  // gitignored (CLAUDE-CONTEXT.md, etc.) doivent être EXCLUES des
  // co-change pairs, sinon elles polluent le top-N (régénérées par
  // hook = co-changent mécaniquement avec tout commit).
  it('excludes gitignored derived files from pairs (ADR-029)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'co-change-derived-'))
    try {
      execSync('git init -q', { cwd: tmp })
      execSync('git config user.email test@test', { cwd: tmp })
      execSync('git config user.name Test', { cwd: tmp })
      execSync('git config commit.gpgsign false', { cwd: tmp })

      // 3 commits : src.ts co-modifié avec DERIVED.md à chaque fois.
      // DERIVED.md sera gitignored après-coup (= simulation d'un fichier
      // historiquement tracked puis sorti du tracking).
      for (let i = 0; i < 3; i++) {
        await fs.writeFile(path.join(tmp, 'src.ts'), `export const x = ${i}\n`)
        await fs.writeFile(path.join(tmp, 'DERIVED.md'), `regen ${i}\n`)
        execSync(`git add . && git commit -q -m c${i}`, { cwd: tmp })
      }

      // Avant gitignore : la pair (DERIVED.md, src.ts) est présente
      const before = await analyzeCoChange(tmp, { minCount: 2 })
      const pairBefore = before.find((p) => p.from === 'DERIVED.md' && p.to === 'src.ts')
      expect(pairBefore, 'pair présente avant gitignore').toBeDefined()

      // On gitignore DERIVED.md + le retire du tracking (= état post-ADR-027 P1)
      await fs.writeFile(path.join(tmp, '.gitignore'), 'DERIVED.md\n')
      execSync('git rm --cached DERIVED.md', { cwd: tmp })
      execSync('git add . && git commit -q -m gitignore-derived', { cwd: tmp })

      // Après : la pair doit avoir disparu (DERIVED.md filtré via git check-ignore)
      const after = await analyzeCoChange(tmp, { minCount: 2 })
      const pairAfter = after.find((p) => p.from === 'DERIVED.md' || p.to === 'DERIVED.md')
      expect(pairAfter, 'pair impliquant DERIVED.md doit être filtrée post-gitignore').toBeUndefined()
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  it('preserves legitimate non-tracked pairs (ex: test.tsx ↔ source.ts) when not gitignored', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'co-change-tsx-'))
    try {
      execSync('git init -q', { cwd: tmp })
      execSync('git config user.email test@test', { cwd: tmp })
      execSync('git config user.name Test', { cwd: tmp })
      execSync('git config commit.gpgsign false', { cwd: tmp })

      for (let i = 0; i < 3; i++) {
        await fs.writeFile(path.join(tmp, 'source.ts'), `export const x = ${i}\n`)
        await fs.writeFile(path.join(tmp, 'source.test.tsx'), `// test ${i}\n`)
        execSync(`git add . && git commit -q -m c${i}`, { cwd: tmp })
      }

      // .tsx pas dans knownFiles (glob `.ts` seulement) mais PAS gitignored.
      // L'ADR-029 ne doit pas le filtrer — il est légitimement consommé via
      // la sémantique "au moins UN côté known".
      const knownFiles = new Set(['source.ts'])
      const pairs = await analyzeCoChange(tmp, { minCount: 2, knownFiles })
      const pair = pairs.find((p) => p.from === 'source.test.tsx' && p.to === 'source.ts')
      expect(pair, 'pair test↔source légitime préservée').toBeDefined()
      expect(pair!.count).toBe(3)
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  it('derivedPaths override : caller peut forcer une liste explicite (sans appel git)', async () => {
    // Override la détection auto en passant un Set explicite. Permet aux
    // tests et aux projets qui veulent une liste indépendante du
    // .gitignore courant.
    const pairs = await analyzeCoChange(repo, {
      minCount: 2,
      derivedPaths: new Set(['a.ts']),  // force a.ts comme dérivé
    })
    for (const p of pairs) {
      expect(p.from).not.toBe('a.ts')
      expect(p.to).not.toBe('a.ts')
    }
  })
})
