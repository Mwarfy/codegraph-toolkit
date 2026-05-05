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

  it('produces snapshot with sémantic parity on 19 swapped fields', async () => {
    const { rootDir } = setupFixture()
    const cfg = { rootDir, include: ['src/**/*.ts'], exclude: [], entryPoints: [] }
    const legacy = await analyze(cfg)
    const datalog = await analyze(cfg, { useDatalog: true })

    expectSetEqual(legacy.snapshot.magicNumbers, datalog.snapshot.magicNumbers,
      (m) => `${m.file}|${m.line}|${m.value}|${m.context}|${m.category}`, 'magicNumbers')
    expectSetEqual(legacy.snapshot.evalCalls, datalog.snapshot.evalCalls,
      (e) => `${e.file}|${e.line}|${e.kind}|${e.containingSymbol}`, 'evalCalls')
    expectSetEqual(legacy.snapshot.cryptoCalls, datalog.snapshot.cryptoCalls,
      (c) => `${c.file}|${c.line}|${c.fn}|${c.algo}|${c.containingSymbol}`, 'cryptoCalls')
    expectSetEqual(legacy.snapshot.booleanParams, datalog.snapshot.booleanParams,
      (b) => `${b.file}|${b.name}|${b.line}|${b.paramIndex}|${b.paramName}|${b.totalParams}`, 'booleanParams')
    expectSetEqual(legacy.snapshot.sanitizerCalls, datalog.snapshot.sanitizerCalls,
      (s) => `${s.file}|${s.line}|${s.callee}|${s.containingSymbol}`, 'sanitizerCalls')
    expectSetEqual(legacy.snapshot.taintSinks, datalog.snapshot.taintSinks,
      (s) => `${s.file}|${s.line}|${s.kind}|${s.callee}|${s.containingSymbol}`, 'taintSinks')
    expectSetEqual(
      (legacy.snapshot.longFunctions ?? []).filter((l) => l.loc >= 100),
      datalog.snapshot.longFunctions,
      (l) => `${l.file}|${l.line}|${l.name}|${l.loc}|${l.kind}`, 'longFunctions(loc>=100)')
    expectSetEqual(legacy.snapshot.functionComplexity, datalog.snapshot.functionComplexity,
      (c) => `${c.file}|${c.line}|${c.name}|${c.cyclomatic}|${c.cognitive}|${c.containingClass}`, 'functionComplexity')
    expectSetEqual(legacy.snapshot.eventListenerSites, datalog.snapshot.eventListenerSites,
      (e) => `${e.file}|${e.line}|${e.symbol}|${e.callee}|${e.kind}|${e.literalValue ?? ''}`, 'eventListenerSites')
    expectSetEqual(legacy.snapshot.barrels, datalog.snapshot.barrels,
      (b) => `${b.file}|${b.reExportCount}|${b.consumerCount}|${b.lowValue}`, 'barrels')
    expectSetEqual(legacy.snapshot.envUsage, datalog.snapshot.envUsage,
      (u) => `${u.name}|${u.isSecret}|${u.readers.length}`, 'envUsage')
    expectSetEqual(legacy.snapshot.constantExpressions, datalog.snapshot.constantExpressions,
      (c) => `${c.file}|${c.line}|${c.kind}|${c.exprRepr}`, 'constantExpressions')
    expectSetEqual(legacy.snapshot.argumentsFacts?.taintedArgs, datalog.snapshot.argumentsFacts?.taintedArgs,
      (a) => `${a.callerFile}|${a.callerSymbol}|${a.callee}|${a.paramIndex}|${a.source}`, 'argumentsFacts.taintedArgs')
    expectSetEqual(legacy.snapshot.argumentsFacts?.params, datalog.snapshot.argumentsFacts?.params,
      (p) => `${p.file}|${p.symbol}|${p.paramName}|${p.paramIndex}`, 'argumentsFacts.params')
    expectSetEqual(legacy.snapshot.eventEmitSites, datalog.snapshot.eventEmitSites,
      (e) => `${e.file}|${e.line}|${e.symbol}|${e.callee}|${e.kind}`, 'eventEmitSites')
    expectSetEqual(legacy.snapshot.taintedVars?.decls, datalog.snapshot.taintedVars?.decls,
      (d) => `${d.file}|${d.containingSymbol}|${d.varName}|${d.line}|${d.source}`, 'taintedVars.decls')
    expectSetEqual(legacy.snapshot.taintedVars?.argCalls, datalog.snapshot.taintedVars?.argCalls,
      (a) => `${a.file}|${a.line}|${a.callee}|${a.argVarName}|${a.argIndex}|${a.source}`, 'taintedVars.argCalls')
    expectSetEqual(legacy.snapshot.resourceImbalances, datalog.snapshot.resourceImbalances,
      (r) => `${r.file}|${r.containingSymbol}|${r.line}|${r.pair}|${r.acquireCount}|${r.releaseCount}`, 'resourceImbalances')
    // securityPatterns sub-arrays
    expectSetEqual(legacy.snapshot.securityPatterns?.secretRefs, datalog.snapshot.securityPatterns?.secretRefs,
      (s) => `${s.file}|${s.line}|${s.varName}|${s.kind}`, 'securityPatterns.secretRefs')
    expectSetEqual(legacy.snapshot.securityPatterns?.corsConfigs, datalog.snapshot.securityPatterns?.corsConfigs,
      (c) => `${c.file}|${c.line}|${c.originKind}`, 'securityPatterns.corsConfigs')
    expectSetEqual(legacy.snapshot.securityPatterns?.tlsUnsafe, datalog.snapshot.securityPatterns?.tlsUnsafe,
      (t) => `${t.file}|${t.line}|${t.key}`, 'securityPatterns.tlsUnsafe')
    expectSetEqual(legacy.snapshot.securityPatterns?.weakRandoms, datalog.snapshot.securityPatterns?.weakRandoms,
      (w) => `${w.file}|${w.line}|${w.varName}|${w.secretKind}`, 'securityPatterns.weakRandoms')
    // codeQualityPatterns sub-arrays — NB: legacy peut avoir doublons sur
    // même file:line (regexLiterals, allocationInLoops). Datalog déduplique.
    // Utilise un set qui les compte distincts pour éviter le faux ✗.
    expectSetEqual(legacy.snapshot.codeQualityPatterns?.tryCatchSwallows, datalog.snapshot.codeQualityPatterns?.tryCatchSwallows,
      (t) => `${t.file}|${t.line}|${t.kind}|${t.containingSymbol}`, 'tryCatchSwallows')
    expectSetEqual(legacy.snapshot.codeQualityPatterns?.awaitInLoops, datalog.snapshot.codeQualityPatterns?.awaitInLoops,
      (a) => `${a.file}|${a.line}|${a.loopKind}|${a.containingSymbol}`, 'awaitInLoops')
    // driftSignals : 4 AST kinds direct + todo-no-owner via isTodoExempt
    expectSetEqual(legacy.snapshot.driftSignals, datalog.snapshot.driftSignals,
      (s) => `${s.kind}|${s.file}|${s.line}`, 'driftSignals')
    // A.4.1 — hardcodedSecrets : full shape avec trigger, entropy 2-decimals
    expectSetEqual(legacy.snapshot.hardcodedSecrets, datalog.snapshot.hardcodedSecrets,
      (h) => `${h.file}|${h.line}|${h.context}|${h.preview}|${h.entropy}|${h.length}|${h.trigger}`,
      'hardcodedSecrets')
    // A.4.2 — deadCode : 6 kinds full coverage via délégation visitor → legacy
    expectSetEqual(legacy.snapshot.deadCode, datalog.snapshot.deadCode,
      (d) => `${d.kind}|${d.file}|${d.line}|${d.message}|${JSON.stringify(d.details ?? {})}`,
      'deadCode')
  })
})
