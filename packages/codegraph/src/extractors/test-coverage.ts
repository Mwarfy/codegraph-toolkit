/**
 * Structural Test Coverage Detector — déterministe, conventions-based.
 *
 * Cross-référence src/**\/*.ts avec tests/**\/*.test.ts par 2 méthodes :
 *   1. Naming convention : `src/foo/bar.ts` ↔ `tests/foo/bar.test.ts`
 *      ou `__tests__/bar.test.ts` adjacent.
 *   2. Imports : un fichier de test qui importe `from '../src/foo/bar'`
 *      couvre `bar.ts`. Croisement via les imports déjà extraits par
 *      ts-imports detector.
 *
 * Sortie : par fichier source, un flag `hasTest: boolean` + la liste des
 * tests couvrants. Les fichiers sans aucun test sont les candidats à
 * doubler par un test.
 *
 * Pas de coverage runtime — purely structural. Ne dit pas "X% des lignes
 * couvertes" mais "ce fichier a-t-il ne serait-ce qu'un test associé".
 *
 * Note : ce detector consomme les imports déjà calculés (ts-imports edges).
 * Donc il ne peut pas être Salsa-isé naïvement — il dépend de l'agrégat
 * global des edges. C'est OK : pour un detector cross-fichier global,
 * recompute si edges change est acceptable (déjà le cas pour cycles,
 * module-metrics, etc.).
 */

import * as path from 'node:path'
import * as fs from 'node:fs/promises'

export interface TestCoverageEntry {
  /** File path source (rel to rootDir). */
  sourceFile: string
  /** Test files qui couvrent ce fichier. Vide = uncovered. */
  testFiles: string[]
  /** Méthode de découverte : 'naming' (convention path) ou 'import' (edge). */
  matchedBy: Array<'naming' | 'import'>
}

export interface TestCoverageReport {
  entries: TestCoverageEntry[]
  /** Stats agrégées. */
  totalSourceFiles: number
  coveredFiles: number
  uncoveredFiles: number
  /** Coverage ratio (0-1). */
  coverageRatio: number
}

/**
 * Suit les `export ... from '...'` re-export edges d'1 niveau pour
 * propager la couverture test → barrel → cibles re-exportées.
 *
 * Pourquoi 1 niveau seulement : empêche les sur-attributions FP. Un test
 * qui touche `package/src/index.ts` couvre ses re-exports directs (le
 * barrel a une responsabilité d'API publique), mais pas les internes
 * transitifs (qui devraient avoir leurs propres tests).
 *
 * Limité à `export * from` et `export { X } from` patterns. Les `import`
 * réguliers ne propagent pas la coverage (un fichier qui importe un util
 * ne le "teste" pas).
 */
async function applyTransitiveReexportCoverage(
  rootDir: string,
  coverage: Map<string, Map<string, Set<'naming' | 'import'>>>,
  sourceSet: Set<string>,
): Promise<void> {
  const reexportRegex = /export\s+(?:\*|\{[^}]*\}|type\s+\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g
  // Snapshot des barrels actuellement couverts (avant mutation).
  const coveredBarrels = [...coverage.entries()].map(([file, tests]) => ({ file, tests }))

  for (const { file: barrel, tests } of coveredBarrels) {
    let content: string
    try {
      content = await fs.readFile(path.join(rootDir, barrel), 'utf-8')
    } catch { continue }

    reexportRegex.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = reexportRegex.exec(content)) !== null) {
      const spec = m[1]
      if (!spec.startsWith('.')) continue
      const target = resolveRelative(barrel, spec, sourceSet)
      if (!target) continue
      // Propage tous les tests du barrel vers la cible re-exportée.
      if (!coverage.has(target)) coverage.set(target, new Map())
      const targetTests = coverage.get(target)!
      for (const [testFile, methods] of tests) {
        if (!targetTests.has(testFile)) targetTests.set(testFile, new Set())
        for (const method of methods) targetTests.get(testFile)!.add(method)
      }
    }
  }
}

/**
 * Discover test files in repo (independent of `files` array — tests are
 * souvent excluded from main analysis but on les veut ici).
 */
async function discoverTestFiles(rootDir: string): Promise<string[]> {
  const result: string[] = []
  await walkForTests(rootDir, rootDir, result)
  return result
}

async function walkForTests(dir: string, rootDir: string, result: string[]): Promise<void> {
  const skipDirs = new Set([
    'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
    '.turbo', '.cache', 'docker-data', '.codegraph',
  ])
  const dirName = path.basename(dir)
  if (skipDirs.has(dirName)) return

  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkForTests(fullPath, rootDir, result)
    } else if (entry.isFile() && isTestFile(entry.name)) {
      const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/')
      result.push(relPath)
    }
  }
}

function isTestFile(basename: string): boolean {
  return /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(basename)
}

/**
 * Résout un import relatif depuis un fichier test vers un fichier source.
 * Strip les extensions ESM .js → .ts, essaie .ts/.tsx/index.
 */
function resolveRelative(
  fromFile: string,
  spec: string,
  sourceSet: Set<string>,
): string | null {
  const fromDir = path.dirname(fromFile)
  const stripped = spec.replace(/\.(js|jsx|ts|tsx|mjs|cjs)$/, '')
  const candidates = [
    `${stripped}.ts`,
    `${stripped}.tsx`,
    `${stripped}/index.ts`,
    `${stripped}/index.tsx`,
    spec,  // already has extension
  ]
  for (const c of candidates) {
    const resolved = path.posix.normalize(path.posix.join(fromDir, c))
    if (sourceSet.has(resolved)) return resolved
  }
  return null
}

/**
 * Convertit un test path en candidate source paths (naming convention).
 * Couvre les patterns courants :
 *   - `src/foo/bar.test.ts` → `src/foo/bar.ts`
 *   - `tests/foo/bar.test.ts` → `src/foo/bar.ts` (mirror)
 *   - `src/foo/__tests__/bar.test.ts` → `src/foo/bar.ts`
 *   - `packages/X/tests/foo.test.ts` → `packages/X/src/foo.ts`
 */
function candidateSourceFromTest(testFile: string): string[] {
  const candidates: string[] = []
  const noExt = testFile.replace(/\.(test|spec)\.(ts|tsx|js|jsx)$/, '')
  const parts = noExt.split('/')

  // Pattern 1 : adjacent — replace .test. by . in same dir
  candidates.push(`${noExt}.ts`, `${noExt}.tsx`)

  // Pattern 2 : __tests__/X → ../X
  const testsDirIdx = parts.indexOf('__tests__')
  if (testsDirIdx >= 0) {
    const before = parts.slice(0, testsDirIdx)
    const after = parts.slice(testsDirIdx + 1)
    const stripped = [...before, ...after].join('/')
    candidates.push(`${stripped}.ts`, `${stripped}.tsx`)
  }

  // Pattern 3 : tests/X → src/X
  const testsIdx = parts.indexOf('tests')
  if (testsIdx >= 0) {
    const before = parts.slice(0, testsIdx)
    const after = parts.slice(testsIdx + 1)
    const stripped = [...before, 'src', ...after].join('/')
    candidates.push(`${stripped}.ts`, `${stripped}.tsx`)
  }

  return candidates
}

/**
 * Build coverage report for a list of source files.
 *
 * `edges` (optionnel) : edges import du graph principal — utiles si les
 * tests sont déjà dans `files`. Sinon, on scanne directement les
 * test files via regex pour résoudre leurs imports.
 *
 * Note : les fichiers de test sont typiquement exclus de `files` (config
 * codegraph), donc leurs imports n'apparaissent pas dans `edges`. Pour
 * couvrir ce cas, on fait un scan regex secondaire sur les test files.
 */
export async function analyzeTestCoverage(
  rootDir: string,
  sourceFiles: string[],
  edges: Array<{ from: string; to: string; type: string }>,
): Promise<TestCoverageReport> {
  const sourceSet = new Set(sourceFiles)
  const testFiles = await discoverTestFiles(rootDir)
  const testSet = new Set(testFiles)

  // Map: source → Set<{ test, method }>
  const coverage = new Map<string, Map<string, Set<'naming' | 'import'>>>()

  // Method 1 : naming convention
  for (const test of testFiles) {
    const candidates = candidateSourceFromTest(test)
    for (const candidate of candidates) {
      if (sourceSet.has(candidate)) {
        if (!coverage.has(candidate)) coverage.set(candidate, new Map())
        if (!coverage.get(candidate)!.has(test)) coverage.get(candidate)!.set(test, new Set())
        coverage.get(candidate)!.get(test)!.add('naming')
        break  // first match wins for naming
      }
    }
  }

  // Method 2a : imports déjà calculés dans le graph principal (cas où
  // les tests sont dans `files`).
  for (const e of edges) {
    if (e.type !== 'import') continue
    if (!testSet.has(e.from)) continue
    if (!sourceSet.has(e.to)) continue
    if (!coverage.has(e.to)) coverage.set(e.to, new Map())
    if (!coverage.get(e.to)!.has(e.from)) coverage.get(e.to)!.set(e.from, new Set())
    coverage.get(e.to)!.get(e.from)!.add('import')
  }

  // Method 2b : scan regex secondaire sur les fichiers tests qui ne sont
  // pas dans `files` (cas le plus courant). Résout les imports relatifs
  // vers les sources.
  //
  // Note : on doit matcher `import type { ... }` aussi — un test contract
  // qui n'importe que des types depuis un fichier compte comme couvrant
  // ce fichier (cf. core-types-contract.test.ts qui lock le schema de
  // core/types.ts). Sans le `(?:type\s+)?`, ces tests étaient invisibles.
  const importRegex = /import\s+(?:(?:type\s+)?(?:\{[^}]*\}|\w+|\*\s+as\s+\w+)\s+from\s+)?['"]([^'"]+)['"]/g
  for (const test of testFiles) {
    let content: string
    try {
      content = await fs.readFile(path.join(rootDir, test), 'utf-8')
    } catch { continue }

    importRegex.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = importRegex.exec(content)) !== null) {
      const spec = m[1]
      if (!spec.startsWith('.')) continue  // skip bare/alias
      const resolved = resolveRelative(test, spec, sourceSet)
      if (!resolved) continue
      if (!coverage.has(resolved)) coverage.set(resolved, new Map())
      if (!coverage.get(resolved)!.has(test)) coverage.get(resolved)!.set(test, new Set())
      coverage.get(resolved)!.get(test)!.add('import')
    }
  }

  // Method 3 : transitive via re-exports.
  //
  // Quand un test importe un barrel (ex: `salsa/src/index.ts`) qui
  // re-exporte des symbols depuis `database.ts`, le test couvre
  // transitivement `database.ts`. Sans ce raffinement, les fichiers
  // load-bearing accédés uniquement via barrels apparaissaient comme
  // untested → faux positif systémique sur tous les packages avec une
  // entry point en barrel.
  //
  // Heuristique : pour chaque file (le barrel) qui est déjà attribué
  // comme couvert par un test, on regarde ses propres imports (edges
  // sortantes) et on les marque aussi couverts par ce test. Limité à
  // 1 niveau de re-export pour rester déterministe et borné.
  await applyTransitiveReexportCoverage(rootDir, coverage, sourceSet)

  // Build report
  const entries: TestCoverageEntry[] = []
  for (const sourceFile of sourceFiles) {
    const tests = coverage.get(sourceFile)
    if (!tests || tests.size === 0) {
      entries.push({ sourceFile, testFiles: [], matchedBy: [] })
      continue
    }
    const testList = [...tests.keys()].sort()
    const methods = new Set<'naming' | 'import'>()
    for (const m of tests.values()) for (const x of m) methods.add(x)
    entries.push({
      sourceFile,
      testFiles: testList,
      matchedBy: [...methods],
    })
  }
  entries.sort((a, b) => a.sourceFile < b.sourceFile ? -1 : 1)

  const totalSourceFiles = entries.length
  const coveredFiles = entries.filter(e => e.testFiles.length > 0).length
  const uncoveredFiles = totalSourceFiles - coveredFiles
  const coverageRatio = totalSourceFiles === 0 ? 1 : coveredFiles / totalSourceFiles

  return {
    entries,
    totalSourceFiles,
    coveredFiles,
    uncoveredFiles,
    coverageRatio: parseFloat(coverageRatio.toFixed(3)),
  }
}
