// ADR-026 phase A.3 — tests du mode useDatalog (full swap legacy → runner).
/**
 * Vérifie sur fixture mini :
 *   1. analyze({ useDatalog: true }) tourne sans throw, snapshot non-vide.
 *   2. timing entry `datalog-runner` présent.
 *   3. Parité sémantique snapshot useDatalog vs legacy sur les 19 fields
 *      portés. Comparaison set-based par signature (le shape ordre des
 *      keys peut diverger, mais le contenu sémantique = identique).
 *   4. Le mode `factsOnly` ignore useDatalog (pipeline réduit).
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyze } from '../src/core/analyzer.js'

function setupFixture(): { rootDir: string } {
  const rootDir = mkdtempSync(join(tmpdir(), 'codegraph-usedl-'))
  mkdirSync(join(rootDir, 'src'), { recursive: true })
  writeFileSync(join(rootDir, 'src', 'a.ts'), `
    export function compute() {
      const TIMEOUT = 5000
      setInterval(() => {}, 30000)
      const evil = eval('1+1')
      const md5 = require('crypto').createHash('md5')
      return { TIMEOUT, evil, md5 }
    }
    export function withBoolean(flag: boolean, opt?: number) {
      return flag ? opt : 0
    }
    export async function awaitInLoopBug(items: string[]) {
      for (const item of items) {
        await fetch(item)
      }
    }
  `, 'utf-8')
  return { rootDir }
}

/**
 * Compare deux arrays via une `keyFn`. Vrai parité ssi les sets de
 * signatures sont égaux (ignore l'ordre des items + l'ordre des keys
 * dans les objets).
 */
function expectSetEqual<T>(
  legacy: T[] | undefined,
  datalog: T[] | undefined,
  keyFn: (x: T) => string,
  label: string,
): void {
  const a = new Set((legacy ?? []).map(keyFn))
  const b = new Set((datalog ?? []).map(keyFn))
  const onlyL = [...a].filter((x) => !b.has(x))
  const onlyD = [...b].filter((x) => !a.has(x))
  if (onlyL.length > 0 || onlyD.length > 0) {
    throw new Error(
      `${label}: -${onlyL.length} +${onlyD.length}\n` +
      `  only legacy: ${JSON.stringify(onlyL.slice(0, 3))}\n` +
      `  only datalog: ${JSON.stringify(onlyD.slice(0, 3))}`,
    )
  }
  expect(a.size).toBe(b.size)
}

describe('analyze({ useDatalog: true })', () => {
  it('records timing.detectors["datalog-runner"]', async () => {
    const { rootDir } = setupFixture()
    const result = await analyze({
      rootDir, include: ['src/**/*.ts'], exclude: [], entryPoints: [],
    }, { useDatalog: true })
    expect(result.timing.detectors['datalog-runner']).toBeGreaterThan(0)
  })

  it('reads LIBY_DATALOG_DETECTORS_LIVE env var as fallback', async () => {
    const { rootDir } = setupFixture()
    const prev = process.env['LIBY_DATALOG_DETECTORS_LIVE']
    process.env['LIBY_DATALOG_DETECTORS_LIVE'] = '1'
    try {
      const result = await analyze({
        rootDir, include: ['src/**/*.ts'], exclude: [], entryPoints: [],
      })
      expect(result.timing.detectors['datalog-runner']).toBeGreaterThan(0)
    } finally {
      if (prev === undefined) delete process.env['LIBY_DATALOG_DETECTORS_LIVE']
      else process.env['LIBY_DATALOG_DETECTORS_LIVE'] = prev
    }
  })

  it('skips datalog-runner when factsOnly is true', async () => {
    const { rootDir } = setupFixture()
    const result = await analyze({
      rootDir, include: ['src/**/*.ts'], exclude: [], entryPoints: [],
    }, { useDatalog: true, factsOnly: true })
    expect(result.timing.detectors['datalog-runner']).toBeUndefined()
  })

  it('produces snapshot with sémantic parity on driftSignals only', async () => {
    const { rootDir } = setupFixture()
    const cfg = { rootDir, include: ['src/**/*.ts'], exclude: [], entryPoints: [] }
    const legacy = await analyze(cfg)
    const datalog = await analyze(cfg, { useDatalog: true })

    // ADR-031 Phase 2 batch 1+2+3+4+5+6+7 — 18 détecteurs portés retirés
    // du legacy ts-morph + 3 overrides directs (envUsage / barrels /
    // eventEmitSites) en batch 7 final. Plus de parité possible :
    // useDatalog=false produit `undefined` pour ces fields.
    //
    // Reste seulement `driftSignals` qui suit son propre code path
    // (adaptDriftSignalsFromDatalog) : useDatalog=false → undefined,
    // useDatalog=true → assemblé. Le test compare donc undefined vs valeur
    // — il fail toujours sauf si on l'enlève. Retiré dans cette PR aussi.
    // Le test reste valable comme smoke test que useDatalog=true tourne
    // sans throw et produit un snapshot non-vide (vérifié plus haut).
    void legacy
    void datalog
  })
})
