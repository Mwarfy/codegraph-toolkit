#!/usr/bin/env node
/**
 * Bench + verify BIT-IDENTICAL : runs the Datalog-rule detectors prototype
 * vs the legacy ts-morph extractors on the same project.
 */

import { Project } from 'ts-morph'
import { discoverFiles } from '../dist/core/file-discovery.js'
import { extractMagicNumbersFileBundle } from '../dist/extractors/magic-numbers.js'
import { extractDeadCodeFileBundle } from '../dist/extractors/dead-code.js'
import { runDatalogDetectors } from '../dist/datalog-detectors/runner.js'
import { resolve } from 'node:path'

const rootDir = process.argv[2] ? resolve(process.argv[2]) : process.cwd()
console.log(`bench-datalog-detectors on ${rootDir}`)

// 1. Discover files (same logic codegraph uses)
const includeArg = process.argv[3] || 'packages/codegraph/src/**/*.ts'
const files = await discoverFiles(
  rootDir,
  [includeArg],
  ['**/node_modules/**', '**/dist/**', '**/*.test.ts', '**/*.spec.ts'],
)
console.log(`  files: ${files.length}`)

// 2. Build shared ts-morph project
const project = new Project({ skipAddingFilesFromTsConfig: true })
for (const f of files) {
  project.addSourceFileAtPathIfExists(`${rootDir}/${f}`)
}

// Skip predicate matching orchestrator-level analyzeMagicNumbers behavior.
// Datalog rules filter via FileTag("test") set by visitor → on filtre aussi
// le legacy ici pour comparison apples-to-apples au niveau orchestrateur.
const TEST_RE = /(\.test\.tsx?|\.spec\.tsx?|(^|\/)tests?\/|(^|\/)__tests__\/|(^|\/)fixtures?\/)/
const isTestFile = (rel) => TEST_RE.test(rel)

// 3. Run LEGACY extractors
const tLegacy0 = performance.now()
const legacyMagic = []
const legacyDeadIdentical = []
for (const sf of project.getSourceFiles()) {
  const abs = sf.getFilePath()
  const rel = abs.replace(rootDir + '/', '')
  if (!files.includes(rel)) continue
  if (isTestFile(rel)) continue
  const m = extractMagicNumbersFileBundle(sf, rel)
  legacyMagic.push(...m.numbers)
  const d = extractDeadCodeFileBundle(sf, rel)
  for (const f of d.findings) {
    if (f.kind === 'identical-subexpressions') legacyDeadIdentical.push(f)
  }
}
const legacyMs = performance.now() - tLegacy0
console.log(`  legacy: ${legacyMagic.length} magic + ${legacyDeadIdentical.length} dead-id (${legacyMs.toFixed(1)}ms)`)

// 4. Run DATALOG path
const tDl0 = performance.now()
const dl = await runDatalogDetectors({ project, files, rootDir })
const dlMs = performance.now() - tDl0
console.log(`  datalog: ${dl.magicNumbers.length} magic + ${dl.deadCodeIdenticalSubexpressions.length} dead-id (${dlMs.toFixed(1)}ms)`)
console.log(`    extract: ${dl.stats.extractMs.toFixed(1)}ms / eval: ${dl.stats.evalMs.toFixed(1)}ms`)
console.log(`    tuples in: ${dl.stats.tuplesIn} / out: ${dl.stats.tuplesOut}`)

// 5. Diff line-by-line
function diffMagic(legacy, dl) {
  const norm = (m) => `${m.file}\t${m.line}\t${m.value}\t${m.context}\t${m.category}`
  const a = new Set(legacy.map(norm))
  const b = new Set(dl.map((m) => `${m.file}\t${m.line}\t${m.value}\t${m.context}\t${m.category}`))
  const onlyLegacy = [...a].filter((x) => !b.has(x))
  const onlyDl = [...b].filter((x) => !a.has(x))
  return { onlyLegacy, onlyDl }
}
function diffDead(legacy, dl) {
  const norm = (d) => `${d.file}\t${d.line}\t${d.details?.operator}\t${d.details?.expression}`
  const a = new Set(legacy.map(norm))
  const b = new Set(dl.map(norm))
  const onlyLegacy = [...a].filter((x) => !b.has(x))
  const onlyDl = [...b].filter((x) => !a.has(x))
  return { onlyLegacy, onlyDl }
}

const dM = diffMagic(legacyMagic, dl.magicNumbers)
const dD = diffDead(legacyDeadIdentical, dl.deadCodeIdenticalSubexpressions)

if (dM.onlyLegacy.length === 0 && dM.onlyDl.length === 0) {
  console.log('  ✓ MagicNumber : BIT-IDENTICAL')
} else {
  console.log(`  ✗ MagicNumber DIFF : -${dM.onlyLegacy.length} +${dM.onlyDl.length}`)
  console.log('    only legacy:', dM.onlyLegacy.slice(0, 5))
  console.log('    only datalog:', dM.onlyDl.slice(0, 5))
}
if (dD.onlyLegacy.length === 0 && dD.onlyDl.length === 0) {
  console.log('  ✓ DeadCode/identical-subexpressions : BIT-IDENTICAL')
} else {
  console.log(`  ✗ DeadCode DIFF : -${dD.onlyLegacy.length} +${dD.onlyDl.length}`)
  console.log('    only legacy:', dD.onlyLegacy.slice(0, 5))
  console.log('    only datalog:', dD.onlyDl.slice(0, 5))
}

console.log(`\n  Total: legacy=${legacyMs.toFixed(0)}ms vs datalog=${dlMs.toFixed(0)}ms (ratio: ${(dlMs/legacyMs).toFixed(2)}x)`)
