/**
 * Tests pour le pipeline Datalog detectors (ADR-026).
 *
 * Vérifie :
 *   1. Visitor extrait les primitives correctement sur fixtures cibles.
 *   2. Le runner produit des outputs déterministes.
 *   3. Les outputs match BIT-IDENTICAL le legacy extractor (proof of
 *      drop-in replacement).
 */

import { describe, it, expect } from 'vitest'
import { Project } from 'ts-morph'
import { extractAstFactsBundle } from '../src/datalog-detectors/ast-facts-visitor.js'
import { runDatalogDetectors } from '../src/datalog-detectors/runner.js'
import { extractMagicNumbersFileBundle } from '../src/extractors/magic-numbers.js'
import { extractDeadCodeFileBundle } from '../src/extractors/dead-code.js'

function makeProject(files: Array<{ name: string; content: string }>): {
  project: Project
  rootDir: string
  fileNames: string[]
} {
  const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true })
  const rootDir = '/virtual'
  const fileNames: string[] = []
  for (const f of files) {
    project.createSourceFile(`${rootDir}/${f.name}`, f.content, { overwrite: true })
    fileNames.push(f.name)
  }
  return { project, rootDir, fileNames }
}

describe('ast-facts-visitor', () => {
  it('emits NumericLiteralAst with parent context', () => {
    const { project } = makeProject([{
      name: 'a.ts',
      content: `
        const TIMEOUT = 5000
        setInterval(fn, 30000)
        function f() { return x > 1500 }
        const cfg = { timeout: 60000, ratio: 0.5 }
      `,
    }])
    const sf = project.getSourceFiles()[0]
    const bundle = extractAstFactsBundle(sf, 'a.ts')

    const lits = bundle.numericLiterals
    expect(lits.length).toBeGreaterThanOrEqual(4)

    // 30000 in setInterval → CallExpression, callee="setInterval"
    const inSetInterval = lits.find((l) => l.valueText === '30000')
    expect(inSetInterval).toMatchObject({
      parentKind: 'CallExpression',
      parentName: 'setInterval',
      isTrivial: 0,
    })

    // 60000 in property "timeout" → PropertyAssignment
    const inTimeoutProp = lits.find((l) => l.valueText === '60000')
    expect(inTimeoutProp).toMatchObject({
      parentKind: 'PropertyAssignment',
      parentName: 'timeout',
    })

    // 0.5 in property "ratio" → isRatio=1
    const ratio = lits.find((l) => l.valueText === '0.5')
    expect(ratio).toMatchObject({ parentKind: 'PropertyAssignment', isRatio: 1 })

    // 5000 in const TIMEOUT → VariableDeclaration, isScreamingSnake=1
    const constTimeout = lits.find((l) => l.valueText === '5000')
    expect(constTimeout).toMatchObject({
      parentKind: 'VariableDeclaration',
      parentName: 'TIMEOUT',
      isScreamingSnake: 1,
    })

    // 1500 in `x > 1500` → BinaryExpression, parentName="compare >"
    const inCompare = lits.find((l) => l.valueText === '1500')
    expect(inCompare).toMatchObject({
      parentKind: 'BinaryExpression',
      parentName: 'compare >',
    })
  })

  it('emits BinaryExpressionAst with leftIsShortLiteral flag', () => {
    const { project } = makeProject([{
      name: 'b.ts',
      content: `
        if (a === a) console.log('bug')
        if (0 === 0) console.log('trivial')
        if (longVarName > longVarName) console.log('also bug')
      `,
    }])
    const sf = project.getSourceFiles()[0]
    const bundle = extractAstFactsBundle(sf, 'b.ts')

    // 'a' starts with letter (not digit/quote/backtick) → leftIsShortLiteral=0,
    // capturable comme dead-code identical-subexpression.
    const aEqA = bundle.binaryExpressions.find((b) => b.leftText === 'a' && b.rightText === 'a')
    expect(aEqA).toMatchObject({ op: '===', leftIsShortLiteral: 0 })

    // '0 === 0' — '0' starts with digit AND length < 4 → leftIsShortLiteral=1,
    // skipped (constants triviales).
    const zeroEqZero = bundle.binaryExpressions.find((b) => b.leftText === '0' && b.rightText === '0')
    expect(zeroEqZero).toMatchObject({ op: '===', leftIsShortLiteral: 1 })

    const longEq = bundle.binaryExpressions.find((b) => b.leftText === 'longVarName')
    expect(longEq).toMatchObject({ op: '>', leftIsShortLiteral: 0 })
  })

  it('detects test files via FileTag', () => {
    const { project } = makeProject([{
      name: 'foo.test.ts',
      content: 'const x = 5000',
    }])
    const sf = project.getSourceFiles()[0]
    const bundle = extractAstFactsBundle(sf, 'foo.test.ts')
    expect(bundle.fileTags).toContainEqual({ file: 'foo.test.ts', tag: 'test' })
  })
})

describe('runDatalogDetectors — BIT-IDENTICAL vs legacy', () => {
  it('magic-numbers : same output on synthetic fixture', async () => {
    const fixture = [{
      name: 'app.ts',
      content: `
        const TIMEOUT = 5000
        setInterval(fn, 30000)
        const cfg = { timeoutMs: 60000, threshold: 95, ratio: 0.5 }
        function f(x: number) { return x > 1500 }
      `,
    }]
    const { project, fileNames } = makeProject(fixture)
    const dl = await runDatalogDetectors({ project, files: fileNames, rootDir: '/virtual' })

    // Legacy extractor (TEST_FILE_RE doesn't match 'app.ts' — runs)
    const legacy = extractMagicNumbersFileBundle(project.getSourceFiles()[0], 'app.ts')

    const norm = (m: { file: string; line: number; value: string; context: string; category: string }) =>
      `${m.file}:${m.line}:${m.value}:${m.context}:${m.category}`
    const dlSet = dl.magicNumbers.map((m) => norm({ ...m, value: m.value }))
    const legacySet = legacy.numbers.map(norm)

    expect([...dlSet].sort()).toEqual([...legacySet].sort())
  })

  it('dead-code/identical-subexpressions : same output on synthetic fixture', async () => {
    const fixture = [{
      name: 'd.ts',
      content: `
        function bug(a: number) {
          if (a === a) return 1
          if (a > 0 && a > 0) return 2
          return 0
        }
      `,
    }]
    const { project, fileNames } = makeProject(fixture)
    const dl = await runDatalogDetectors({ project, files: fileNames, rootDir: '/virtual' })

    const legacy = extractDeadCodeFileBundle(project.getSourceFiles()[0], 'd.ts')
    const legacyIdentical = legacy.findings
      .filter((f) => f.kind === 'identical-subexpressions')
      .map((f) => `${f.file}:${f.line}`)

    const dlIdentical = dl.deadCodeIdenticalSubexpressions.map((f) => `${f.file}:${f.line}`)

    expect([...dlIdentical].sort()).toEqual([...legacyIdentical].sort())
    expect(dlIdentical.length).toBeGreaterThanOrEqual(2)  // les 2 patterns du fixture
  })

  it('5 runs successifs → bit-identique (déterminisme)', async () => {
    const fixture = [{
      name: 'app.ts',
      content: `
        const x = 5000
        setInterval(fn, 30000)
        const cfg = { timeoutMs: 60000 }
      `,
    }]
    const { project, fileNames } = makeProject(fixture)

    const outputs: string[] = []
    for (let i = 0; i < 5; i++) {
      const dl = await runDatalogDetectors({ project, files: fileNames, rootDir: '/virtual' })
      outputs.push(JSON.stringify({
        magic: dl.magicNumbers,
        dead: dl.deadCodeIdenticalSubexpressions,
      }))
    }
    const first = outputs[0]
    for (const o of outputs) expect(o).toBe(first)
  })

  it('skips test files via FileTag rule', async () => {
    const fixture = [{
      name: 'foo.test.ts',
      content: 'setInterval(fn, 30000)',
    }]
    const { project, fileNames } = makeProject(fixture)
    const dl = await runDatalogDetectors({ project, files: fileNames, rootDir: '/virtual' })
    expect(dl.magicNumbers).toEqual([])
  })
})
