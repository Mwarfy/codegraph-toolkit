// ADR-026 phase A.3 + ADR-031 Phase 2 + audit dette §T1.5
/**
 * Smoke tests du pipeline Datalog (chemin unique depuis ADR-031 P2 +
 * retrait du kill switch `useDatalog` / env `LIBY_DATALOG_LEGACY` en
 * audit dette §T1.5).
 *
 * Vérifie sur fixture mini :
 *   1. `analyze()` tourne le datalog-runner — timing entry présent.
 *   2. Le mode `factsOnly` skippe le pipeline détecteur complet (=
 *      perf path pour les outils qui veulent juste les facts AST).
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
  `, 'utf-8')
  return { rootDir }
}

describe('analyze() — chemin Datalog unique', () => {
  it('records timing.detectors["datalog-runner"] (= runner toujours actif)', async () => {
    const { rootDir } = setupFixture()
    const result = await analyze({
      rootDir, include: ['src/**/*.ts'], exclude: [], entryPoints: [],
    })
    expect(result.timing.detectors['datalog-runner']).toBeGreaterThan(0)
  })

  it('skips datalog-runner when factsOnly is true', async () => {
    const { rootDir } = setupFixture()
    const result = await analyze({
      rootDir, include: ['src/**/*.ts'], exclude: [], entryPoints: [],
    }, { factsOnly: true })
    expect(result.timing.detectors['datalog-runner']).toBeUndefined()
  })
})
