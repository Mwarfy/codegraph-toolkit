// ADR-032
/**
 * Cross-package contract test : `runtime-graph` ↔ `@liby-tools/datalog`.
 *
 * runtime-graph charge dynamiquement `@liby-tools/datalog` pour exécuter
 * ses rules cross-statique × runtime depuis le CLI `liby-runtime-graph`
 * (cf. `src/cli.ts:601-633` — `runRulesAndPrint`). Si datalog renomme
 * `runFromDirs` ou change sa signature, le CLI casse en runtime sans
 * signal CI préalable.
 *
 * Symboles consommés :
 *   - `runFromDirs({ rulesDir, factsDir, recordProofsFor, allowRecursion })`
 *     (cli.ts:628)
 *
 * Le rules dir bundlé (`packages/runtime-graph/rules/`) reste exporté via
 * `@liby-tools/runtime-graph/rules` mais n'est pas testé ici (= responsabilité
 * du package runtime-graph, pas du contrat cross-package).
 */

import { describe, it, expect } from 'vitest'

describe('cross-package contract : runtime-graph ← @liby-tools/datalog', () => {
  it('runFromDirs reste exposé en function', async () => {
    const mod = await import('@liby-tools/datalog')
    expect(typeof mod.runFromDirs).toBe('function')
  })

  it('runFromDirs accepte la signature utilisée par cli.ts', async () => {
    const { runFromDirs } = await import('@liby-tools/datalog')
    // Smoke : si la signature break (ex: rulesDir renommé), TS strict
    // l'attrape à la compilation de ce test. À runtime on vérifie juste
    // que l'appel ne pète pas en construction (rules/facts absents →
    // throw runtime "no rules files" est l'attendu, donc on accepte).
    await expect(
      runFromDirs({
        rulesDir: '/nonexistent-rules',
        factsDir: '/nonexistent-facts',
        recordProofsFor: ['RuntimeAlert'],
        allowRecursion: false,
      }),
    ).rejects.toBeDefined()
  })
})
