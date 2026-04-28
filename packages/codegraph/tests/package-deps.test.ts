/**
 * Tests des extracteurs package-deps + barrels (phase 3.8 #7).
 */

import assert from 'node:assert/strict'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createSharedProject } from '../src/detectors/unused-exports.js'
import { analyzePackageDeps } from '../src/extractors/package-deps.js'
import { analyzeBarrels } from '../src/extractors/barrels.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixtureDir = path.resolve(__dirname, 'fixtures/package-deps')

async function listTsFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(d: string): Promise<void> {
    const entries = await fs.readdir(d, { withFileTypes: true })
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const full = path.join(d, e.name)
      if (e.isDirectory()) await walk(full)
      else if (e.isFile() && /\.tsx?$/.test(e.name)) {
        out.push(path.relative(fixtureDir, full).replace(/\\/g, '/'))
      }
    }
  }
  await walk(dir)
  return out.sort()
}

async function run(): Promise<void> {
  const files = await listTsFiles(fixtureDir)
  const project = createSharedProject(fixtureDir, files, path.join(fixtureDir, 'tsconfig.json'))

  const issues = await analyzePackageDeps(fixtureDir, files, project)
  const barrels = await analyzeBarrels(fixtureDir, files, project)

  // ─── 1. Root manifest — declared-unused ────────────────────────────
  const unused = issues.filter((i) => i.kind === 'declared-unused' && i.packageJson === 'package.json')
  const unusedNames = unused.map((i) => i.packageName).sort()
  assert.deepEqual(unusedNames, ['unused-pkg'], `expected only unused-pkg as declared-unused, got: ${unusedNames.join(',')}`)

  // @types/* ne doit JAMAIS apparaître en declared-unused (filtre explicite).
  assert.ok(!issues.some((i) => i.packageName.startsWith('@types/')), '@types/* should be filtered from declared-unused')

  console.log('✓ package-deps: declared-unused captured (unused-pkg), @types/* filtered')

  // ─── 2. Root manifest — missing ────────────────────────────────────
  const missing = issues.filter((i) => i.kind === 'missing' && i.packageJson === 'package.json')
  const missingNames = missing.map((i) => i.packageName).sort()
  assert.deepEqual(missingNames, ['react'], `expected only react as missing, got: ${missingNames.join(',')}`)

  const reactIssue = missing[0]!
  assert.ok(reactIssue.importers.includes('src/b.ts'), `react importers should include src/b.ts`)

  console.log('✓ package-deps: missing captured (react)')

  // ─── 3. Root manifest — devOnly ────────────────────────────────────
  const devOnly = issues.filter((i) => i.kind === 'devOnly' && i.packageJson === 'package.json')
  const devOnlyNames = devOnly.map((i) => i.packageName).sort()
  assert.deepEqual(devOnlyNames, ['test-only-in-deps'], `expected only test-only-in-deps as devOnly, got: ${devOnlyNames.join(',')}`)
  assert.equal(devOnly[0]!.declaredIn, 'dependencies', 'devOnly must show it was declared in dependencies')
  assert.deepEqual(devOnly[0]!.testImporters?.sort(), ['tests/x.test.ts'])

  // `jest` est importé depuis un test mais déclaré en devDependencies → ne doit PAS
  // apparaître (c'est correctement placé).
  assert.ok(!issues.some((i) => i.packageName === 'jest'), 'jest correctly in devDeps → no issue')

  console.log('✓ package-deps: devOnly captured (test-only-in-deps); jest correctly placed')

  // ─── 4. Subpath normalization (lodash/fp → lodash) ────────────────
  // `lodash/fp` doit être comptabilisé comme `lodash` → pas de « missing lodash ».
  assert.ok(!issues.some((i) => i.packageName === 'lodash'), 'lodash should be classified as used (no issue)')

  console.log('✓ package-deps: subpath imports normalized (lodash/fp → lodash)')

  // ─── 5. Builtins ignored ───────────────────────────────────────────
  assert.ok(!issues.some((i) => i.packageName === 'path' || i.packageName === 'fs'), 'node builtins must not be flagged')

  console.log('✓ package-deps: node:* and builtin names ignored')

  // ─── 6. Multi-manifest scope ───────────────────────────────────────
  const wsIssues = issues.filter((i) => i.packageJson === 'workspace-pkg/package.json')
  assert.equal(wsIssues.length, 0, `workspace-pkg should have zero issues (chalk used + declared), got: ${JSON.stringify(wsIssues)}`)

  // Et `chalk` ne doit pas être flaggé comme missing dans la racine (il vit
  // dans le scope workspace-pkg).
  assert.ok(!issues.some((i) => i.packageName === 'chalk' && i.packageJson === 'package.json'), 'chalk is resolved in workspace-pkg scope, not root')

  console.log('✓ package-deps: per-manifest scope resolution (chalk → workspace-pkg only)')

  // ─── 7. Barrels ────────────────────────────────────────────────────
  const barrelFiles = barrels.map((b) => b.file).sort()
  assert.deepEqual(barrelFiles, ['src/barrel.ts'], `expected only src/barrel.ts as barrel, got: ${barrelFiles.join(',')}`)

  const barrel = barrels[0]!
  assert.equal(barrel.reExportCount, 2, 'barrel.ts has 2 re-exports')
  assert.equal(barrel.consumerCount, 1, 'barrel has 1 consumer (barrel-consumer.ts)')
  assert.deepEqual(barrel.consumers, ['src/barrel-consumer.ts'])
  assert.equal(barrel.lowValue, true, 'consumerCount=1 < threshold=2 → lowValue')

  // `not-a-barrel.ts` ne doit PAS être détecté comme barrel.
  assert.ok(!barrels.some((b) => b.file === 'src/not-a-barrel.ts'), 'not-a-barrel.ts has a non-re-export statement → not a barrel')

  console.log('✓ barrels: src/barrel.ts detected, not-a-barrel.ts excluded, lowValue=true')

  // ─── 8. Déterminisme ───────────────────────────────────────────────
  const project2 = createSharedProject(fixtureDir, files, path.join(fixtureDir, 'tsconfig.json'))
  const issues2 = await analyzePackageDeps(fixtureDir, files, project2)
  const barrels2 = await analyzeBarrels(fixtureDir, files, project2)
  assert.equal(JSON.stringify(issues), JSON.stringify(issues2), 'package-deps output not byte-equivalent between runs')
  assert.equal(JSON.stringify(barrels), JSON.stringify(barrels2), 'barrels output not byte-equivalent between runs')

  console.log('✓ package-deps + barrels: deterministic across runs')
  console.log(`\n  Summary: ${issues.length} issues / ${barrels.length} barrels detected\n  all assertions passed`)
}

run().catch((err) => {
  console.error('✗ package-deps test failed:')
  console.error(err)
  process.exit(1)
})
