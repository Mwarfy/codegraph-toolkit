// ADR-026 phase A.1 — tests du mode shadow datalog dans analyzer.ts.
/**
 * Vérifie :
 *   1. `runDatalogShadow` retourne un report structuré avec 32 checks.
 *   2. Sur une fixture mini : tous les checks `allMatch === true`.
 *   3. `analyze({ datalogShadow: true })` n'altère PAS le snapshot — les
 *      mêmes outputs legacy sont produits avec/sans le flag.
 *   4. Le timing entry `datalog-shadow` est présent quand activé.
 */

import { describe, it, expect } from 'vitest'
import { Project } from 'ts-morph'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runDatalogShadow } from '../src/datalog-detectors/shadow.js'
import { analyze } from '../src/core/analyzer.js'

function setupFixture(): { rootDir: string; files: string[] } {
  const rootDir = mkdtempSync(join(tmpdir(), 'codegraph-shadow-'))
  mkdirSync(join(rootDir, 'src'), { recursive: true })
  // Du code qui déclenche QUELQUES détecteurs (magic-numbers, eval-calls)
  // mais pas tous — les checks vides doivent passer aussi (legacy=0 dl=0).
  writeFileSync(join(rootDir, 'src', 'a.ts'), `
    export function compute() {
      const TIMEOUT = 5000
      setInterval(() => {}, 30000)
      return eval('1+1')
    }
    export function bigFn() {
      ${'console.log("noise");\n'.repeat(120)}
    }
  `, 'utf-8')
  return { rootDir, files: ['src/a.ts'] }
}

describe('runDatalogShadow', () => {
  it('produces a report with all 32 checks matching on a clean fixture', async () => {
    const { rootDir, files } = setupFixture()
    const result = await analyze({
      rootDir,
      include: ['src/**/*.ts'],
      exclude: [],
      entryPoints: [],
    })
    const project = new Project({ skipAddingFilesFromTsConfig: true })
    for (const f of files) project.addSourceFileAtPathIfExists(join(rootDir, f))

    const report = await runDatalogShadow({
      project, files, rootDir, snapshot: result.snapshot,
    })

    expect(report.checks.length).toBe(32)
    expect(report.runnerStats.tuplesIn).toBeGreaterThan(0)

    const failed = report.checks.filter((c) => !c.allMatch)
    if (failed.length > 0) {
      // Diagnostic verbeux si divergence — facilite le debug.
      console.error('shadow mismatches:', failed.map((c) => ({
        name: c.name,
        legacy: c.legacyCount, dl: c.datalogCount,
        onlyLegacy: c.sampleOnlyLegacy,
        onlyDatalog: c.sampleOnlyDatalog,
      })))
    }
    expect(failed).toEqual([])
    expect(report.allMatch).toBe(true)
  })
})

describe('analyze({ datalogShadow: true })', () => {
  it('records timing.detectors["datalog-shadow"] when enabled', async () => {
    const { rootDir } = setupFixture()
    const result = await analyze({
      rootDir,
      include: ['src/**/*.ts'],
      exclude: [],
      entryPoints: [],
    }, { datalogShadow: true })

    expect(result.timing.detectors['datalog-shadow']).toBeGreaterThan(0)
  })

  it('does not mutate snapshot fields vs default analyze', async () => {
    const { rootDir } = setupFixture()
    const baseline = await analyze({
      rootDir,
      include: ['src/**/*.ts'],
      exclude: [],
      entryPoints: [],
    })
    const withShadow = await analyze({
      rootDir,
      include: ['src/**/*.ts'],
      exclude: [],
      entryPoints: [],
    }, { datalogShadow: true })

    // Égalité sur un sous-ensemble représentatif des fields touchés par les
    // 18 détecteurs portés. Comparaison JSON pour éviter les pièges de
    // référence-vs-valeur.
    expect(JSON.stringify(withShadow.snapshot.magicNumbers))
      .toBe(JSON.stringify(baseline.snapshot.magicNumbers))
    expect(JSON.stringify(withShadow.snapshot.evalCalls))
      .toBe(JSON.stringify(baseline.snapshot.evalCalls))
    expect(JSON.stringify(withShadow.snapshot.longFunctions))
      .toBe(JSON.stringify(baseline.snapshot.longFunctions))
  })

  it('reads LIBY_DATALOG_DETECTORS env var as fallback', async () => {
    const { rootDir } = setupFixture()
    const prev = process.env['LIBY_DATALOG_DETECTORS']
    process.env['LIBY_DATALOG_DETECTORS'] = '1'
    try {
      const result = await analyze({
        rootDir,
        include: ['src/**/*.ts'],
        exclude: [],
        entryPoints: [],
      })
      expect(result.timing.detectors['datalog-shadow']).toBeGreaterThan(0)
    } finally {
      if (prev === undefined) delete process.env['LIBY_DATALOG_DETECTORS']
      else process.env['LIBY_DATALOG_DETECTORS'] = prev
    }
  })

  it('skips shadow when factsOnly mode is enabled', async () => {
    const { rootDir } = setupFixture()
    const result = await analyze({
      rootDir,
      include: ['src/**/*.ts'],
      exclude: [],
      entryPoints: [],
    }, { datalogShadow: true, factsOnly: true })

    expect(result.timing.detectors['datalog-shadow']).toBeUndefined()
  })
})
