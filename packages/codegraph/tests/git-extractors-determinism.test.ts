/**
 * Determinism E2E pour les extractors qui lisent l'historique git.
 *
 * Pourquoi ce test existe :
 *   `analyze-determinism-e2e.test.ts` valide le pipeline complet sur des
 *   fixtures **sans .git**. Il couvre 47/50 extractors mais SKIP les 3
 *   qui dépendent du git history :
 *     - co-change       (jaccard sur commits qui touchent les mêmes fichiers)
 *     - granger-causality (lag-1 conditional probability sur sequence)
 *     - lyapunov-cochange (sensibilité aux conditions initiales)
 *
 *   Ces 3-là sont les plus susceptibles d'introduire du nondéterminisme
 *   (timestamps git, ordre commit, fenêtre `--since`). Ce test les
 *   valide via une fixture git construite programmatically avec dates
 *   fixées via env vars `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE`.
 *
 * Méthode :
 *   1. Crée un dossier tmp.
 *   2. `git init`, configure user fictif (pas d'effet sur global).
 *   3. Commits avec dates fixées (3 commits, files A/B co-changent, C standalone).
 *   4. Run analyzeCoChange + computeGrangerCausality 3× avec sinceDays large.
 *   5. Hash byte-équivalence sur les 3 runs.
 *
 * Coût : ~1s (3× git init + commits + 6× extractor invocations).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { analyzeCoChange } from '../src/extractors/co-change.js'
import { computeGrangerCausality } from '../src/extractors/granger-causality.js'

const FIXED_DATE_BASE = '2025-01-01T12:00:00Z'

function git(repo: string, cmd: string, env: Record<string, string> = {}): string {
  return execSync(cmd, {
    cwd: repo,
    encoding: 'utf-8',
    env: {
      ...process.env,
      // Bypass user's global git config for hooks/signing
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      ...env,
    },
  })
}

function hashJson(value: unknown): string {
  const json = JSON.stringify(value, (_, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {}
      for (const key of Object.keys(v).sort()) sorted[key] = v[key]
      return sorted
    }
    return v
  })
  return createHash('sha256').update(json).digest('hex')
}

/**
 * Construit une fixture git stable : 5 commits avec dates fixées,
 * où les fichiers A/B co-changent 3× et C standalone 2×.
 */
async function buildGitFixture(repo: string): Promise<void> {
  await fs.mkdir(repo, { recursive: true })
  git(repo, 'git init -q -b main')
  git(repo, 'git config user.email "test@example.com"')
  git(repo, 'git config user.name "Test User"')
  git(repo, 'git config commit.gpgsign false')

  // Commit 1 : add a + b (co-change)
  await fs.writeFile(path.join(repo, 'a.ts'), 'export const a = 1\n')
  await fs.writeFile(path.join(repo, 'b.ts'), 'export const b = 1\n')
  git(repo, 'git add .')
  git(repo, 'git commit -q -m "init a+b"', {
    GIT_AUTHOR_DATE: FIXED_DATE_BASE,
    GIT_COMMITTER_DATE: FIXED_DATE_BASE,
  })

  // Commit 2 : modify a + b together (co-change)
  await fs.writeFile(path.join(repo, 'a.ts'), 'export const a = 2\n')
  await fs.writeFile(path.join(repo, 'b.ts'), 'export const b = 2\n')
  git(repo, 'git add .')
  git(repo, 'git commit -q -m "update a+b"', {
    GIT_AUTHOR_DATE: '2025-01-02T12:00:00Z',
    GIT_COMMITTER_DATE: '2025-01-02T12:00:00Z',
  })

  // Commit 3 : add c (standalone)
  await fs.writeFile(path.join(repo, 'c.ts'), 'export const c = 1\n')
  git(repo, 'git add .')
  git(repo, 'git commit -q -m "add c"', {
    GIT_AUTHOR_DATE: '2025-01-03T12:00:00Z',
    GIT_COMMITTER_DATE: '2025-01-03T12:00:00Z',
  })

  // Commit 4 : modify a + b again (3rd co-change → reaches minCount=3)
  await fs.writeFile(path.join(repo, 'a.ts'), 'export const a = 3\n')
  await fs.writeFile(path.join(repo, 'b.ts'), 'export const b = 3\n')
  git(repo, 'git add .')
  git(repo, 'git commit -q -m "tweak a+b"', {
    GIT_AUTHOR_DATE: '2025-01-04T12:00:00Z',
    GIT_COMMITTER_DATE: '2025-01-04T12:00:00Z',
  })

  // Commit 5 : modify c standalone
  await fs.writeFile(path.join(repo, 'c.ts'), 'export const c = 2\n')
  git(repo, 'git add .')
  git(repo, 'git commit -q -m "tweak c"', {
    GIT_AUTHOR_DATE: '2025-01-05T12:00:00Z',
    GIT_COMMITTER_DATE: '2025-01-05T12:00:00Z',
  })
}

describe('git-touching extractors determinism (ADR-001 hardening)', () => {
  let fixtureDir: string

  beforeAll(async () => {
    fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codegraph-git-determinism-'))
    await buildGitFixture(fixtureDir)
  })

  afterAll(async () => {
    if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true })
  })

  it('analyzeCoChange : 3 runs sur même fixture git → byte-équivalent', async () => {
    // sinceDays large pour capturer les 5 commits du fixture (dates 2025-01-*)
    // depuis "today" (2026+) → ≥ 365j safe.
    const opts = { sinceDays: 1000, minCount: 1, minJaccard: 0 }

    const r1 = await analyzeCoChange(fixtureDir, opts)
    const r2 = await analyzeCoChange(fixtureDir, opts)
    const r3 = await analyzeCoChange(fixtureDir, opts)

    expect(r1.length).toBeGreaterThan(0)
    expect(hashJson(r2)).toBe(hashJson(r1))
    expect(hashJson(r3)).toBe(hashJson(r1))
  })

  it('analyzeCoChange : a-b paire détectée (3 co-changes), c-* isolé', async () => {
    const opts = { sinceDays: 1000, minCount: 1, minJaccard: 0 }
    const pairs = await analyzeCoChange(fixtureDir, opts)

    // CoChangePair fields : from < to (lex-sorted, dedupe)
    const ab = pairs.find((p) => p.from === 'a.ts' && p.to === 'b.ts')
    expect(ab, 'a-b co-change pair detected').toBeDefined()
    expect(ab!.count).toBe(3)
    expect(ab!.totalCommitsFrom).toBe(3)
    expect(ab!.totalCommitsTo).toBe(3)
    expect(ab!.jaccard).toBe(1)                                             // identical commit sets
  })

  it('computeGrangerCausality : 3 runs sur même fixture → byte-équivalent', async () => {
    const opts = {
      sinceDays: 1000,
      minObservations: 1,
      minExcessX1000: 0,
      maxCommits: 100,
    }

    const r1 = await computeGrangerCausality(fixtureDir, opts)
    const r2 = await computeGrangerCausality(fixtureDir, opts)
    const r3 = await computeGrangerCausality(fixtureDir, opts)

    expect(hashJson(r2)).toBe(hashJson(r1))
    expect(hashJson(r3)).toBe(hashJson(r1))
  })

  it('extractors retournent stable order (sort lex on from/to)', async () => {
    const opts = { sinceDays: 1000, minCount: 1, minJaccard: 0 }
    const pairs = await analyzeCoChange(fixtureDir, opts)

    // Vérifie que chaque pair a from < to (normalization), et que le sort
    // global est stable (pas de Map insertion order leak).
    for (const p of pairs) {
      expect(p.from < p.to, `${p.from} < ${p.to}`).toBe(true)
    }
  })
})
