#!/usr/bin/env node
/**
 * Bench + verify BIT-IDENTICAL : runs the Datalog-rule detectors prototype
 * vs the legacy ts-morph extractors on the same project.
 *
 * Usage: node bench-datalog-detectors.mjs [rootDir] [includeGlob]
 */

import { Project } from 'ts-morph'
import { discoverFiles } from '../dist/core/file-discovery.js'
import { extractMagicNumbersFileBundle } from '../dist/extractors/magic-numbers.js'
import { extractDeadCodeFileBundle } from '../dist/extractors/dead-code.js'
import { extractEvalCallsFileBundle } from '../dist/extractors/eval-calls.js'
import { extractCryptoCallsFileBundle } from '../dist/extractors/crypto-algo.js'
import { extractBooleanParamsFileBundle } from '../dist/extractors/boolean-params.js'
import { runDatalogDetectors } from '../dist/datalog-detectors/runner.js'
import { resolve } from 'node:path'

const rootDir = process.argv[2] ? resolve(process.argv[2]) : process.cwd()
console.log(`bench-datalog-detectors on ${rootDir}`)

const includeArg = process.argv[3] || 'packages/codegraph/src/**/*.ts'
const files = await discoverFiles(
  rootDir,
  [includeArg],
  ['**/node_modules/**', '**/dist/**', '**/*.test.ts', '**/*.spec.ts'],
)
console.log(`  files: ${files.length}`)

const project = new Project({ skipAddingFilesFromTsConfig: true })
for (const f of files) {
  project.addSourceFileAtPathIfExists(`${rootDir}/${f}`)
}

const TEST_RE = /(\.test\.tsx?|\.spec\.tsx?|(^|\/)tests?\/|(^|\/)__tests__\/|(^|\/)fixtures?\/)/
const isTestFile = (rel) => TEST_RE.test(rel)

// LEGACY
const tLegacy0 = performance.now()
const legacyMagic = []
const legacyDeadIdentical = []
const legacyEval = []
const legacyCrypto = []
const legacyBool = []
for (const sf of project.getSourceFiles()) {
  const abs = sf.getFilePath()
  const rel = abs.replace(rootDir + '/', '')
  if (!files.includes(rel)) continue
  if (isTestFile(rel)) continue
  legacyMagic.push(...extractMagicNumbersFileBundle(sf, rel).numbers)
  for (const f of extractDeadCodeFileBundle(sf, rel).findings) {
    if (f.kind === 'identical-subexpressions') legacyDeadIdentical.push(f)
  }
  legacyEval.push(...extractEvalCallsFileBundle(sf, rel).calls)
  legacyCrypto.push(...extractCryptoCallsFileBundle(sf, rel).calls)
  legacyBool.push(...extractBooleanParamsFileBundle(sf, rel).sites)
}
const legacyMs = performance.now() - tLegacy0
console.log(`  legacy: magic=${legacyMagic.length} dead=${legacyDeadIdentical.length} eval=${legacyEval.length} crypto=${legacyCrypto.length} bool=${legacyBool.length} (${legacyMs.toFixed(1)}ms)`)

// DATALOG
const tDl0 = performance.now()
const dl = await runDatalogDetectors({ project, files, rootDir })
const dlMs = performance.now() - tDl0
console.log(`  datalog: magic=${dl.magicNumbers.length} dead=${dl.deadCodeIdenticalSubexpressions.length} eval=${dl.evalCalls.length} crypto=${dl.cryptoCalls.length} bool=${dl.booleanParams.length} (${dlMs.toFixed(1)}ms)`)
console.log(`    extract: ${dl.stats.extractMs.toFixed(1)}ms / eval: ${dl.stats.evalMs.toFixed(1)}ms`)
console.log(`    tuples in: ${dl.stats.tuplesIn} / out: ${dl.stats.tuplesOut}`)

// DIFF helpers
function bidirDiff(legacy, dl, normFn, label) {
  const a = new Set(legacy.map(normFn))
  const b = new Set(dl.map(normFn))
  const onlyL = [...a].filter((x) => !b.has(x))
  const onlyD = [...b].filter((x) => !a.has(x))
  if (onlyL.length === 0 && onlyD.length === 0) {
    console.log(`  ✓ ${label} : BIT-IDENTICAL (${legacy.length})`)
    return true
  }
  console.log(`  ✗ ${label} DIFF : -${onlyL.length} +${onlyD.length}`)
  if (onlyL.length) console.log(`    only legacy:`, onlyL.slice(0, 5))
  if (onlyD.length) console.log(`    only datalog:`, onlyD.slice(0, 5))
  return false
}

const ok1 = bidirDiff(legacyMagic, dl.magicNumbers,
  (m) => `${m.file}\t${m.line}\t${m.value}\t${m.context}\t${m.category}`, 'MagicNumber')
const ok2 = bidirDiff(legacyDeadIdentical, dl.deadCodeIdenticalSubexpressions,
  (d) => `${d.file}\t${d.line}\t${d.details?.operator}\t${d.details?.expression}`, 'DeadCode/identical')
const ok3 = bidirDiff(legacyEval, dl.evalCalls,
  (e) => `${e.file}\t${e.line}\t${e.kind}\t${e.containingSymbol}`, 'EvalCall')
const ok4 = bidirDiff(legacyCrypto, dl.cryptoCalls,
  (c) => `${c.file}\t${c.line}\t${c.fn}\t${c.algo}\t${c.containingSymbol}`, 'CryptoCall')
const ok5 = bidirDiff(legacyBool, dl.booleanParams,
  (b) => `${b.file}\t${b.name}\t${b.line}\t${b.paramIndex}\t${b.paramName}\t${b.totalParams}`, 'BooleanParam')

const allOk = ok1 && ok2 && ok3 && ok4 && ok5
console.log(`\n  Total: legacy=${legacyMs.toFixed(0)}ms vs datalog=${dlMs.toFixed(0)}ms (ratio: ${(dlMs/legacyMs).toFixed(2)}x)${allOk ? ' ✓' : ' ✗'}`)
if (!allOk) process.exit(1)
