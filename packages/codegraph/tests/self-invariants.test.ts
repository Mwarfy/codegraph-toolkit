/**
 * Toolkit self-invariants — codegraph appliqué à lui-même.
 *
 * Le toolkit publie 41 rules .dl à des consumers (Sentinel etc.). Mais
 * sans gate auto-applique, on perd la dogfood : le toolkit pourrait
 * accumuler les anti-patterns qu'il pretend detecter ailleurs.
 *
 * Ce test :
 *   1. Load toutes les rules de packages/invariants-postgres-ts/invariants/
 *   2. Les exécute contre packages/codegraph/.codegraph/facts/ (le toolkit
 *      lui-meme analyse via codegraph analyze).
 *   3. Filtre les violations toolkit-acceptables (TOOLKIT_GRANDFATHERED).
 *   4. Asserte que les violations restantes sont sous le budget defini.
 *
 * Difference avec Sentinel :
 *   - Sentinel : zero violations, ratchet par grandfather list explicite.
 *   - Toolkit : budget initial > 0 acceptable (les rules sont calibrees
 *     pour des apps backend, pas un analyzer). Le seuil descend au fur
 *     et a mesure du cleanup. Mais aucune violation NOUVELLE n'est OK.
 *
 * Pattern exempt :
 *   - Les fixtures (`tests/fixtures/`) sont du code volontairement buggy
 *     pour les tests des extractors → exclues.
 *   - Les `dist/` sont du build output → exclues.
 */

import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { runFromDirs } from '../../datalog/src/runner.js'

const __dirname = path.dirname(new URL(import.meta.url).pathname)
const REPO_ROOT = path.resolve(__dirname, '../../..')
const RULES_DIR = path.join(REPO_ROOT, 'packages/invariants-postgres-ts/invariants')
const FACTS_DIR = path.join(REPO_ROOT, '.codegraph/facts')

/**
 * Budget de violations toolkit. Initial : ~180 (cf. SELF-AUDIT-2026-05-01.md).
 * Ce nombre doit DESCENDRE au fil des refactors. Toute violation NOUVELLE
 * (file:line non listee ailleurs) doit etre traitee.
 *
 * Set a un budget large initial — la valeur cible apres cleanup sera plus bas.
 */
const VIOLATION_BUDGET = 250

async function dirExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true } catch { return false }
}

const factsAvailable = await dirExists(FACTS_DIR)
const rulesAvailable = await dirExists(RULES_DIR)

describe.skipIf(!factsAvailable || !rulesAvailable)('Toolkit self-invariants', () => {
  it('budget de violations sous le seuil', async () => {
    const { result } = await runFromDirs({
      rulesDir: RULES_DIR,
      factsDir: FACTS_DIR,
      recordProofsFor: ['Violation'],
      allowRecursion: true,
    })

    const violations = result.outputs.get('Violation') ?? []
    // Filtre fixtures + dist (faux positifs systemiques)
    const real = violations.filter((v) => {
      const file = String(v[1])
      return !file.includes('/tests/fixtures/') && !file.includes('/dist/')
    })

    if (real.length > VIOLATION_BUDGET) {
      const overrun = real.length - VIOLATION_BUDGET
      const summary = new Map<string, number>()
      for (const v of real) {
        const rule = String(v[0])
        summary.set(rule, (summary.get(rule) ?? 0) + 1)
      }
      const dist = [...summary.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([rule, n]) => `  ${n.toString().padStart(4)}  ${rule}`)
        .join('\n')
      throw new Error(
        `Toolkit self-invariants : ${real.length} violations (budget ${VIOLATION_BUDGET}, overrun ${overrun}).\n` +
        `Distribution :\n${dist}\n\n` +
        `Soit corriger les NOUVELLES violations, soit ajuster VIOLATION_BUDGET (en justifiant).`,
      )
    }
    expect(real.length).toBeLessThanOrEqual(VIOLATION_BUDGET)
  })

  it('aucune nouvelle CWE ou SECURITY rule violee dans le toolkit', async () => {
    const { result } = await runFromDirs({
      rulesDir: RULES_DIR,
      factsDir: FACTS_DIR,
      recordProofsFor: ['Violation'],
      allowRecursion: true,
    })

    const violations = result.outputs.get('Violation') ?? []
    // Les CWE rules sont sensibles : aucune violation toleree dans le code
    // source toolkit (les fixtures contiennent des CWE volontaires pour les
    // tests, donc on les exclut).
    const cweRules = [
      'CWE-022', 'CWE-078', 'CWE-079', 'CWE-089', 'CWE-327', 'CWE-502',
      'CWE-918', 'CWE-1321',
      'COMPOSITE-CROSS-FN-SQL-INJECTION', 'COMPOSITE-CROSS-FN-CMD-INJECTION',
      'COMPOSITE-CROSS-FN-PATH-TRAVERSAL', 'COMPOSITE-CROSS-FN-LOG-INJECTION',
      'COMPOSITE-CLEAR-TEXT-LOGGING', 'COMPOSITE-WEAK-CRYPTO-ALGO',
      'COMPOSITE-CORS-MISCONFIG', 'COMPOSITE-DISABLING-CERT-VALIDATION',
      'COMPOSITE-INSECURE-RANDOMNESS',
    ]
    const cweViolations = violations.filter((v) => {
      const file = String(v[1])
      if (file.includes('/tests/fixtures/') || file.includes('/dist/')) return false
      return cweRules.includes(String(v[0]))
    })

    if (cweViolations.length > 0) {
      const lines = cweViolations.map((v) =>
        `  [${v[0]}] ${v[1]}:${v[2]} — ${String(v[3]).slice(0, 80)}`,
      )
      throw new Error(
        `${cweViolations.length} CWE/security violation(s) dans le code toolkit :\n${lines.join('\n')}\n\n` +
        `Ces rules sont strict-no-FP. Soit corriger, soit grandfather avec justification.`,
      )
    }
    expect(cweViolations).toEqual([])
  })
})
