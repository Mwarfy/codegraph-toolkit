// ADR-005
/**
 * Unused Exports Detector — Smart Classification
 *
 * Scans every TypeScript file for exported symbols, then classifies each
 * unused export with a confidence level:
 *
 *   used            — imported by at least one source file
 *   test-only       — not imported by source, but imported by test files
 *   possibly-dynamic— symbol name found in string literals / dynamic patterns
 *   local-only      — exported but only referenced within the same file
 *   safe-to-remove  — zero evidence of usage anywhere
 *
 * Three analysis passes:
 *   1. AST import map (static imports from source files)
 *   2. Test file import scan (separate ts-morph pass on test files)
 *   3. Dynamic usage heuristic (regex scan for symbol names in strings)
 *   4. Local usage detection (symbol referenced in same file body)
 *
 * Uses ts-morph for AST analysis.
 */

import { Project, Node, SyntaxKind, type SourceFile } from 'ts-morph'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import type { ExportSymbol, ExportConfidence } from '../core/types.js'
import { resolveAliasStandalone } from '../detectors/ts-imports.js'
import {
  isNextJsRouteFile as _isNextJsRouteFile,
  isNextJsFrameworkExport as _isNextJsFrameworkExport,
  isToolConfigFile as _isToolConfigFile,
  isToolConfigExport as _isToolConfigExport,
} from '../core/framework-conventions.js'

export interface FileExportInfo {
  /** Relative file path */
  file: string
  /** All exported symbols */
  exports: ExportSymbol[]
  /** Count of unused exports */
  unusedCount: number
  /** Total export count */
  totalCount: number
  /** Count by confidence level (only for unused) */
  byConfidence?: Record<ExportConfidence, number>
}

/**
 * Initialise un `ts-morph` Project avec tous les fichiers source.
 * Exposé pour que d'autres détecteurs (complexity, find_definition) puissent
 * réutiliser la même instance et éviter de re-parser — gain mémoire majeur
 * sur gros projets.
 */
export function createSharedProject(
  rootDir: string,
  files: string[],
  tsConfigPath?: string,
): Project {
  const project = new Project({
    ...(tsConfigPath ? { tsConfigFilePath: tsConfigPath } : {}),
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      allowJs: true,
      resolveJsonModule: true,
    },
  })

  for (const relPath of files) {
    const absPath = path.join(rootDir, relPath)
    try {
      project.addSourceFileAtPath(absPath)
    } catch (e) {
      // Skip unparseable files. Ce catch est SILENCIEUX par design (fichiers
      // genuinement malformés), mais c'est aussi un suspect pour le flake
      // déterminisme E2E : un échec I/O transitoire sous charge (104 forks,
      // pression fd) droppe silencieusement un fichier → facts manquants.
      // `DET_DEBUG=1` rend ces échecs observables pour la prochaine occurrence.
      if (process.env.DET_DEBUG) {
        console.error(`[DET_DEBUG] addSourceFileAtPath FAILED: ${relPath} — ${(e as Error)?.message}`)
      }
    }
  }
  return project
}

/**
 * Bundle per-file extrait des AST/regex d'UN sourceFile. Réutilisable
 * côté Salsa (Sprint 11.2) — la dépendance Salsa unique est `fileContent`,
 * donc ce bundle est cacheable per-file, et l'agrégation globale
 * (importUsageMap, namespaceImporters, dynamicSymbolHits) reste pure.
 *
 * Structures sérialisables : pas de Set/Map ni références ts-morph.
 */
export interface UnusedExportsImportRef {
  targetFile: string
  symbol: string  // 'default' ou nom du named import
}

export interface UnusedExportsDeclaredExport {
  /** "(default)" pour le default export, sinon le nom. */
  symbolName: string
  /** Nom brut tel que retourné par getExportedDeclarations (utile pour lookups). */
  rawName: string
  kind: ExportSymbol['kind']
  line: number
  isReExport: boolean
  isUsedLocally: boolean
}

export interface UnusedExportsFileBundle {
  /** Imports nommés ou default (statiques + dynamiques destructurés). */
  importedSymbols: UnusedExportsImportRef[]
  /** Namespaces importés ou re-exportés depuis ce fichier. */
  namespaceTargets: string[]
  /** Symboles candidats trouvés dans des string literals (heuristique dynamic). */
  stringLiteralSymbols: string[]
  /** Exports déclarés dans ce fichier. */
  declaredExports: UnusedExportsDeclaredExport[]
}

/**
 * Extrait le bundle per-file. Dépend uniquement du SourceFile + Project
 * (pour la résolution des `getModuleSpecifierSourceFile`) + rootDir.
 *
 * `relPath` est le path relatif du fichier (clé "files" + clé namespace).
 */
function collectImportRefs(
  sourceFile: SourceFile,
  rootDir: string,
  importedSymbols: UnusedExportsImportRef[],
  namespaceTargets: string[],
  fromPath: string,
  allFiles: readonly string[],
): void {
  for (const imp of sourceFile.getImportDeclarations()) {
    const specifier = imp.getModuleSpecifierValue()
    const targetPath = resolveImportTarget(imp.getModuleSpecifierSourceFile(), specifier, fromPath, rootDir, allFiles)
    if (!targetPath) continue

    if (imp.getNamespaceImport()) {
      namespaceTargets.push(targetPath)
      continue
    }
    if (imp.getDefaultImport()) {
      importedSymbols.push({ targetFile: targetPath, symbol: 'default' })
    }
    for (const named of imp.getNamedImports()) {
      importedSymbols.push({ targetFile: targetPath, symbol: named.getName() })
    }
  }
}

/** Resolve an import specifier to a project-relative file path.
 *  Falls back to the alias resolver (handles `@/foo` / `~/foo` shapes
 *  the bundled tsconfig may not know about — typically when codegraph
 *  is pointed at a single tsconfig in a multi-project monorepo). */
function resolveImportTarget(
  resolvedSf: SourceFile | undefined,
  specifier: string,
  fromPath: string,
  rootDir: string,
  allFiles: readonly string[],
): string | null {
  if (resolvedSf) {
    const p = relativize(resolvedSf.getFilePath(), rootDir)
    if (p) return p
  }
  if (specifier.startsWith('@/') || specifier.startsWith('~/')) {
    return resolveAliasStandalone(specifier, fromPath, allFiles as string[])
  }
  return null
}

function collectExportRefs(
  sourceFile: SourceFile,
  rootDir: string,
  importedSymbols: UnusedExportsImportRef[],
  namespaceTargets: string[],
  fromPath: string,
  allFiles: readonly string[],
): void {
  for (const exp of sourceFile.getExportDeclarations()) {
    const specifier = exp.getModuleSpecifierValue()
    if (!specifier) continue  // `export { X }` without `from`
    const targetPath = resolveImportTarget(exp.getModuleSpecifierSourceFile(), specifier, fromPath, rootDir, allFiles)
    if (!targetPath) continue

    if (!exp.getNamedExports().length && exp.isNamespaceExport()) {
      namespaceTargets.push(targetPath)
      continue
    }
    for (const named of exp.getNamedExports()) {
      importedSymbols.push({ targetFile: targetPath, symbol: named.getName() })
    }
  }
}

/**
 * `await import('./path')` destructure : capture les symbols pour ne pas
 * faussement marquer "safe-to-remove" les exports utilises en lazy.
 */
function recordDynamicImportBinding(
  parent: Node | undefined,
  targetPath: string,
  importedSymbols: UnusedExportsImportRef[],
  namespaceTargets: string[],
): void {
  if (!parent || !Node.isVariableDeclaration(parent)) {
    namespaceTargets.push(targetPath)
    return
  }
  const nameNode = parent.getNameNode()
  if (Node.isObjectBindingPattern(nameNode)) {
    for (const element of nameNode.getElements()) {
      const propNameNode = element.getPropertyNameNode()
      const name = propNameNode ? propNameNode.getText() : element.getNameNode().getText()
      importedSymbols.push({ targetFile: targetPath, symbol: name })
    }
    return
  }
  // Identifier ou autre forme — namespace import.
  namespaceTargets.push(targetPath)
}

function collectDynamicImports(
  sourceFile: SourceFile,
  rootDir: string,
  project: Project,
  importedSymbols: UnusedExportsImportRef[],
  namespaceTargets: string[],
): void {
  // Fix M-003 : detector v1 ne voyait que les imports statiques. Les
  // consumers lazy via `await import(...)` voyaient leur cible faussement
  // marquee "safe-to-remove".
  for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = callExpr.getExpression()
    if (expr.getText() !== 'import') continue

    const args = callExpr.getArguments()
    if (args.length === 0) continue
    const firstArg = args[0]
    if (!Node.isStringLiteral(firstArg) && !Node.isNoSubstitutionTemplateLiteral(firstArg)) continue
    const specifier = firstArg.getLiteralValue()
    if (!specifier.startsWith('.')) continue

    const targetPath = resolveDynamicImport(specifier, sourceFile, rootDir, project)
    if (!targetPath) continue

    let parent: Node | undefined = callExpr.getParent()
    if (parent && Node.isAwaitExpression(parent)) parent = parent.getParent()
    recordDynamicImportBinding(parent, targetPath, importedSymbols, namespaceTargets)
  }
}

const STRING_LITERAL_SYMBOL_RE = /['"`]([A-Za-z_$][A-Za-z0-9_$]*(?:Schema|Params|Handler|Action|Event|Type|Config)?)['"` ]/g

function collectStringLiteralSymbols(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const matches = text.match(STRING_LITERAL_SYMBOL_RE)
  if (!matches) return out
  for (const m of matches) {
    const clean = m.replace(/['"`\s]/g, '')
    if (clean.length > 2 && !seen.has(clean)) {
      seen.add(clean)
      out.push(clean)
    }
  }
  return out
}

function collectDeclaredExports(
  sourceFile: SourceFile,
  text: string,
): UnusedExportsDeclaredExport[] {
  const out: UnusedExportsDeclaredExport[] = []
  for (const [name, declarations] of sourceFile.getExportedDeclarations()) {
    for (const decl of declarations) {
      const kind = classifyDeclaration(decl)
      const line = decl.getStartLineNumber()
      const isReExport = decl.getSourceFile() !== sourceFile
      const symbolName = name === 'default' ? '(default)' : name
      const isUsedLocally = name !== 'default' && isUsedLocallyOnly(text, name, line)
      out.push({ symbolName, rawName: name, kind, line, isReExport, isUsedLocally })
    }
  }
  return out
}

export function extractUnusedExportsFileBundle(
  sourceFile: SourceFile,
  relPath: string,
  rootDir: string,
  project: Project,
  allFiles: readonly string[] = [],
): UnusedExportsFileBundle {
  const importedSymbols: UnusedExportsImportRef[] = []
  const namespaceTargets: string[] = []

  collectImportRefs(sourceFile, rootDir, importedSymbols, namespaceTargets, relPath, allFiles)
  collectExportRefs(sourceFile, rootDir, importedSymbols, namespaceTargets, relPath, allFiles)
  collectDynamicImports(sourceFile, rootDir, project, importedSymbols, namespaceTargets)

  const text = sourceFile.getFullText()
  const stringLiteralSymbols = collectStringLiteralSymbols(text)
  const declaredExports = collectDeclaredExports(sourceFile, text)

  return {
    importedSymbols,
    namespaceTargets,
    stringLiteralSymbols,
    declaredExports,
  }
}

/**
 * Analyze all files and return per-file export usage data with smart classification.
 * Si `sharedProject` est fourni, il est réutilisé — sinon un Project est créé.
 */
export async function analyzeExports(
  rootDir: string,
  files: string[],
  tsConfigPath?: string,
  sharedProject?: Project,
): Promise<FileExportInfo[]> {

  // ─── 1. Initialize ts-morph project (source files) ────────────────

  const project = sharedProject ?? createSharedProject(rootDir, files, tsConfigPath)

  // ─── 2. Extract per-file bundles (Sprint 11.2) ────────────────────
  // Bundles sont sérialisables, dérivés d'UN fichier, cacheables côté
  // Salsa. Ici on les extrait synchronement en boucle.

  const bundlesByFile = new Map<string, UnusedExportsFileBundle>()

  for (const sourceFile of project.getSourceFiles()) {
    const filePath = relativize(sourceFile.getFilePath(), rootDir)
    if (!filePath) continue
    const bundle = extractUnusedExportsFileBundle(sourceFile, filePath, rootDir, project, files)
    bundlesByFile.set(filePath, bundle)
  }

  // ─── 3. Aggregate bundles → import maps ───────────────────────────

  const { importUsageMap, namespaceImporters, dynamicSymbolHits } =
    aggregateBundles(bundlesByFile)

  // ─── 4. Scan test files with lightweight regex (no second ts-morph) ─

  const testFilesIndex = await buildTestFilesIndex(rootDir)

  // ─── 5. Classify exports per file using the bundles + global indexes ─

  return classifyExportsFromBundles(
    files,
    bundlesByFile,
    importUsageMap,
    namespaceImporters,
    dynamicSymbolHits,
    testFilesIndex,
  )
}

/**
 * Helper pure : agrège les bundles per-file en maps globales.
 * Pas de Project ni I/O — réutilisable côté Salsa.
 */
export function aggregateBundles(
  bundlesByFile: Map<string, UnusedExportsFileBundle>,
): {
  importUsageMap: Map<string, Set<string>>
  namespaceImporters: Map<string, Set<string>>
  dynamicSymbolHits: Set<string>
} {
  const importUsageMap = new Map<string, Set<string>>()
  const namespaceImporters = new Map<string, Set<string>>()
  const dynamicSymbolHits = new Set<string>()

  for (const [importerFile, bundle] of bundlesByFile) {
    for (const ref of bundle.importedSymbols) {
      const key = `${ref.targetFile}:${ref.symbol}`
      let users = importUsageMap.get(key)
      if (!users) {
        users = new Set()
        importUsageMap.set(key, users)
      }
      users.add(importerFile)
    }
    for (const target of bundle.namespaceTargets) {
      let users = namespaceImporters.get(target)
      if (!users) {
        users = new Set()
        namespaceImporters.set(target, users)
      }
      users.add(importerFile)
    }
    for (const sym of bundle.stringLiteralSymbols) {
      dynamicSymbolHits.add(sym)
    }
  }

  return { importUsageMap, namespaceImporters, dynamicSymbolHits }
}

/**
 * Test files index — symbols et basenames référencés par les fichiers
 * de test. Built async par scan regex (pas de second Project ts-morph).
 *
 * Sérialisable JSON natif (`Record<string, string[]>`) : utilisable
 * comme input Salsa avec `setInputIfChanged` (signature JSON stable).
 */
export interface TestFilesIndex {
  /** symbolName → liste de fichiers de test qui le référencent. */
  symbolHits: Record<string, string[]>
  /** sourceBasename → liste de fichiers de test qui importent ce module. */
  fileImports: Record<string, string[]>
}

// Regex 1 : import statique
const STATIC_IMPORT_RE = /import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+['"]([^'"]+)['"]/g
// Regex 2 : dynamic import (Fix M-006)
const DYNAMIC_IMPORT_RE = /(?:const|let|var)\s+(?:\{([^}]+)\}|(\w+))\s*=\s*await\s+import\s*\(\s*['"]([^'"]+)['"]\s*\)/g

interface ImportIndices {
  symbolHits: Map<string, Set<string>>
  fileImports: Map<string, Set<string>>
}

interface ProcessedImport {
  namedImports: string | undefined
  identifierImport: string | undefined
  modulePath: string
  testFile: string
}

function recordModuleBasename(modulePath: string, testFile: string, fileImports: Map<string, Set<string>>): void {
  const basename = modulePath.split('/').pop()?.replace(/\.(js|ts|tsx)$/, '') || ''
  if (!basename) return
  let users = fileImports.get(basename)
  if (!users) { users = new Set(); fileImports.set(basename, users) }
  users.add(testFile)
}

function recordNamedImports(namedImports: string, testFile: string, symbolHits: Map<string, Set<string>>): void {
  for (const part of namedImports.split(',')) {
    const symbolName = part.trim().split(/\s*[:]|\s+as\s+/)[0].trim()
    if (!symbolName) continue
    let users = symbolHits.get(symbolName)
    if (!users) { users = new Set(); symbolHits.set(symbolName, users) }
    users.add(testFile)
  }
}

function processImportMatch(p: ProcessedImport, indices: ImportIndices): void {
  recordModuleBasename(p.modulePath, p.testFile, indices.fileImports)
  if (p.namedImports) recordNamedImports(p.namedImports, p.testFile, indices.symbolHits)
  if (p.identifierImport) {
    let users = indices.symbolHits.get(p.identifierImport)
    if (!users) { users = new Set(); indices.symbolHits.set(p.identifierImport, users) }
    users.add(p.testFile)
  }
}

function scanImportsInFile(content: string, testFile: string, indices: ImportIndices): void {
  // Local regex pour eviter state lastIndex partage (paranoia).
  const staticRe = new RegExp(STATIC_IMPORT_RE.source, STATIC_IMPORT_RE.flags)
  let match
  while ((match = staticRe.exec(content)) !== null) {
    processImportMatch({ namedImports: match[1], identifierImport: match[2], modulePath: match[3], testFile }, indices)
  }
  const dynamicRe = new RegExp(DYNAMIC_IMPORT_RE.source, DYNAMIC_IMPORT_RE.flags)
  while ((match = dynamicRe.exec(content)) !== null) {
    processImportMatch({ namedImports: match[1], identifierImport: match[2], modulePath: match[3], testFile }, indices)
  }
}

/**
 * Convert Set → array sorte pour signature JSON stable (Sprint 11.2 :
 * setInputIfChanged compare via JSON.stringify, l'ordre des entrees
 * doit etre deterministe pour skip-set warm).
 */
function freezeIndex(indices: ImportIndices): { symbolHits: Record<string, string[]>; fileImports: Record<string, string[]> } {
  const symbolHits: Record<string, string[]> = {}
  for (const k of [...indices.symbolHits.keys()].sort()) {
    symbolHits[k] = [...indices.symbolHits.get(k)!].sort()
  }
  const fileImports: Record<string, string[]> = {}
  for (const k of [...indices.fileImports.keys()].sort()) {
    fileImports[k] = [...indices.fileImports.get(k)!].sort()
  }
  return { symbolHits, fileImports }
}

export async function buildTestFilesIndex(rootDir: string): Promise<TestFilesIndex> {
  const testFiles = await discoverTestFiles(rootDir)
  const indices: ImportIndices = {
    symbolHits: new Map(),
    fileImports: new Map(),
  }

  // Lit N test files en parallèle (I/O fs indépendantes), parse séquentiel.
  const testContents = await Promise.all(
    testFiles.map(async (testFile) => {
      const absPath = path.join(rootDir, testFile)
      try {
        return { testFile, content: await fs.readFile(absPath, 'utf-8') }
      } catch { return null }
    }),
  )
  for (const entry of testContents) {
    if (!entry) continue
    scanImportsInFile(entry.content, entry.testFile, indices)
  }

  return freezeIndex(indices)
}

/**
 * Helper pure : classifie les exports per file à partir des bundles +
 * index globaux. Pas d'I/O ni Project — réutilisable côté Salsa.
 */
interface ClassifyContext {
  filePath: string
  decl: UnusedExportsDeclaredExport
  allUsers: Set<string>
  allTestUsers: Set<string>
  dynamicSymbolHits: Set<string>
}

/**
 * Classify confidence selon priorite : used > framework > tool-config >
 * test-only > possibly-dynamic > local-only > safe-to-remove. La 1ere
 * regle qui matche gagne (early-return guard clauses).
 */
function classifyExportConfidence(ctx: ClassifyContext): { confidence: ExportConfidence; reason?: string } {
  const { filePath, decl, allUsers, allTestUsers, dynamicSymbolHits } = ctx
  const name = decl.rawName

  if (allUsers.size > 0 || decl.isReExport) {
    return { confidence: 'used' }
  }
  if (isNextJsFrameworkExport(filePath, name)) {
    return { confidence: 'used', reason: 'Next.js framework convention export (read reflectively by runtime)' }
  }
  if (isToolConfigExport(filePath, name)) {
    return { confidence: 'used', reason: 'Tool config (read by runner)' }
  }
  if (allTestUsers.size > 0) {
    return {
      confidence: 'test-only',
      reason: `imported by ${allTestUsers.size} test file(s): ${[...allTestUsers].slice(0, 3).map(f => shortPath(f)).join(', ')}`,
    }
  }
  if (name !== 'default' && dynamicSymbolHits.has(name)) {
    return {
      confidence: 'possibly-dynamic',
      reason: `symbol name "${name}" found in string literals (possible dynamic lookup)`,
    }
  }
  if (decl.isUsedLocally) {
    return {
      confidence: 'local-only',
      reason: `referenced in same file but not imported elsewhere — remove \`export\` keyword`,
    }
  }
  return {
    confidence: 'safe-to-remove',
    reason: 'no imports in source, tests, or dynamic patterns',
  }
}

interface ClassifyDeclArgs {
  filePath: string
  decl: UnusedExportsDeclaredExport
  importUsageMap: Map<string, Set<string>>
  nsUsers: Set<string>
  dynamicSymbolHits: Set<string>
  testIndex: TestFilesIndex
}

function classifyDeclaredExport(args: ClassifyDeclArgs): ExportSymbol {
  const { filePath, decl, importUsageMap, nsUsers, dynamicSymbolHits, testIndex } = args
  const name = decl.rawName

  const key = name === 'default' ? `${filePath}:default` : `${filePath}:${name}`
  const directUsers = importUsageMap.get(key) || new Set<string>()
  const allUsers = new Set([...directUsers, ...nsUsers])
  allUsers.delete(filePath)

  const testHits = name !== 'default' ? (testIndex.symbolHits[name] || []) : []
  const allTestUsers = new Set(testHits)

  const { confidence, reason } = classifyExportConfidence({
    filePath, decl, allUsers, allTestUsers, dynamicSymbolHits,
  })

  return {
    name: decl.symbolName,
    kind: decl.kind,
    line: decl.line,
    usageCount: allUsers.size,
    usedBy: allUsers.size > 0 ? [...allUsers].sort() : undefined,
    reExport: decl.isReExport || undefined,
    confidence,
    reason,
  }
}

function summarizeFileExports(filePath: string, fileExports: ExportSymbol[]): FileExportInfo {
  const unusedCount = fileExports.filter(e => e.usageCount === 0 && !e.reExport).length
  const byConfidence: Record<ExportConfidence, number> = {
    'used': 0, 'test-only': 0, 'possibly-dynamic': 0, 'local-only': 0, 'safe-to-remove': 0,
  }
  for (const e of fileExports) {
    if (e.confidence) byConfidence[e.confidence]++
  }
  return {
    file: filePath,
    exports: fileExports.sort((a, b) => a.line - b.line),
    unusedCount,
    totalCount: fileExports.length,
    byConfidence,
  }
}

export function classifyExportsFromBundles(
  files: string[],
  bundlesByFile: Map<string, UnusedExportsFileBundle>,
  importUsageMap: Map<string, Set<string>>,
  namespaceImporters: Map<string, Set<string>>,
  dynamicSymbolHits: Set<string>,
  testIndex: TestFilesIndex,
): FileExportInfo[] {
  const results: FileExportInfo[] = []
  const fileSet = new Set(files)

  for (const [filePath, bundle] of bundlesByFile) {
    if (!fileSet.has(filePath)) continue

    const nsUsers = namespaceImporters.get(filePath) || new Set<string>()
    const fileExports: ExportSymbol[] = bundle.declaredExports.map((decl) =>
      classifyDeclaredExport({ filePath, decl, importUsageMap, nsUsers, dynamicSymbolHits, testIndex }),
    )

    if (fileExports.length > 0) {
      results.push(summarizeFileExports(filePath, fileExports))
    }
  }

  return results
}

// ─── Test File Discovery ────────────────────────────────────────────

async function discoverTestFiles(rootDir: string): Promise<string[]> {
  const testFiles: string[] = []
  // Walk depuis rootDir avec les mêmes excludes que le walker. Sans scan
  // des tests, les exports consommés uniquement par eux seraient faussement
  // classés safe-to-remove.
  try {
    await walkForTests(rootDir, rootDir, testFiles)
  } catch {
    // rootDir absent — silent
  }
  return testFiles
}

async function walkForTests(dir: string, rootDir: string, result: string[]): Promise<void> {
  const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.turbo', '.cache', 'docker-data'])
  const dirName = path.basename(dir)
  if (skipDirs.has(dirName)) return

  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  // Files matchent localement, dirs récursés en parallèle (push partagé OK).
  const subdirs: string[] = []
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      subdirs.push(fullPath)
    } else if (entry.isFile()) {
      const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/')
      if (isTestFile(relativePath)) {
        result.push(relativePath)
      }
    }
  }
  await Promise.all(subdirs.map((sd) => walkForTests(sd, rootDir, result)))
}

/**
 * Détection fichier de test.
 *
 * Fix M-005 : reçoit désormais le PATH relatif (pas le basename). L'ancienne
 * impl. recevait `entry.name` et testait `includes('/tests/')` — ne pouvait
 * jamais matcher. Conséquence : les tests sous `src/tests/` sans suffixe
 * `.test.` / `.spec.` (ex: test-systems.ts, critical-paths.ts, etc.) étaient
 * invisibles → leurs usages de symboles marqués safe-to-remove.
 */
function isTestFile(filePath: string): boolean {
  const basename = filePath.split('/').pop() ?? filePath
  return /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(basename) ||
         filePath.includes('__tests__/') ||
         filePath.includes('/tests/')
}

// ─── Framework conventions (single source of truth) ──────────────────────
//
// Fix M-008 + M-010 : les fichiers de routing Next.js App Router (page,
// layout, route, middleware, instrumentation...) et les configs outillage
// (next.config, vitest.config, sentry.*.config, ...) sont chargés par
// réflexion depuis le runtime, pas par import explicite. Sans whitelist,
// le detector les classait safe-to-remove.
//
// La logique vit dans `core/framework-conventions.ts` pour être partagée
// avec `core/graph.ts` (classification orphan/entry-point).

const isNextJsRouteFile = _isNextJsRouteFile
const isNextJsFrameworkExport = _isNextJsFrameworkExport
const isToolConfigFile = _isToolConfigFile
const isToolConfigExport = _isToolConfigExport

// ─── Local Usage Detection ──────────────────────────────────────────

/**
 * Check if a symbol name is referenced elsewhere in the same file
 * beyond its own declaration. This catches cases where a type is
 * exported but only used as a return type or parameter type within
 * the same file.
 */
function isUsedLocallyOnly(fileText: string, symbolName: string, declLine: number): boolean {
  // Create a regex that matches the symbol as a whole word
  // but not in import/re-export statements.
  //
  // Fix M-004 : l'ancien skip `/^\s*(import|export)\s/` était trop large —
  // il éliminait aussi `export const X = … SymbolName …` et
  // `export type Y = … SymbolName …`, qui sont de VRAIS usages internes.
  // Désormais on ne skip que :
  //   - les imports purs
  //   - les re-exports nommés `export { X } from '...'`
  //   - les re-exports typés `export type { X } from '...'`
  // Les `export const/function/class/type/interface/enum ...` gardent leur
  // body analysé — c'est là que les types sont vraiment consommés.
  const regex = new RegExp(`\\b${escapeRegex(symbolName)}\\b`, 'g')
  const lines = fileText.split('\n')
  let localUseCount = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1

    // Skip the declaration line itself
    if (lineNum === declLine) continue

    // Skip pure import lines
    if (/^\s*import\s/.test(line)) continue

    // Skip named re-exports — `export { X, Y } from '...'` ou `export type { X } from '...'`
    if (/^\s*export\s+(type\s+)?\{/.test(line)) continue

    // Skip `export * from '...'` / `export * as X from '...'`
    if (/^\s*export\s+\*/.test(line)) continue

    if (regex.test(line)) {
      localUseCount++
      regex.lastIndex = 0 // Reset for next test
    }
  }

  return localUseCount > 0
}

/**
 * Résoudre un `await import('./path.js')` vers un fichier source du Project.
 * Convention ESM+TS : strip l'extension .js/.ts et essayer les candidats
 * concrets `.ts/.tsx/.js/.jsx/index.*`. Retourne le path relatif au rootDir.
 */
function resolveDynamicImport(
  specifier: string,
  sourceFile: SourceFile,
  rootDir: string,
  project: Project,
): string | null {
  const dir = path.dirname(sourceFile.getFilePath())
  const stripped = specifier.replace(/\.(js|jsx|ts|tsx|mjs|cjs)$/, '')

  const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx']

  for (const ext of extensions) {
    const candidate = path.resolve(dir, stripped + ext)
    const sf = project.getSourceFile(candidate)
    if (sf) {
      return relativize(sf.getFilePath(), rootDir)
    }
  }

  // Fallback : le spécificateur a déjà sa bonne extension
  const direct = path.resolve(dir, specifier)
  const sfDirect = project.getSourceFile(direct)
  if (sfDirect) {
    return relativize(sfDirect.getFilePath(), rootDir)
  }

  return null
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ─── Helpers ────────────────────────────────────────────────────────

function classifyDeclaration(decl: Node): ExportSymbol['kind'] {
  if (Node.isFunctionDeclaration(decl) || Node.isFunctionExpression(decl)) return 'function'
  if (Node.isClassDeclaration(decl)) return 'class'
  if (Node.isInterfaceDeclaration(decl)) return 'interface'
  if (Node.isTypeAliasDeclaration(decl)) return 'type'
  if (Node.isEnumDeclaration(decl)) return 'enum'
  if (Node.isVariableDeclaration(decl)) {
    const parent = decl.getParent()
    if (Node.isVariableDeclarationList(parent)) {
      if (parent.getText().startsWith('const')) return 'const'
    }
    return 'variable'
  }
  if (Node.isVariableStatement(decl)) return 'const'
  return 'other'
}

function relativize(absPath: string, rootDir: string): string | null {
  const normalized = absPath.replace(/\\/g, '/')
  const rootNormalized = rootDir.replace(/\\/g, '/')
  if (!normalized.startsWith(rootNormalized)) return null
  return normalized.slice(rootNormalized.length + 1)
}

function shortPath(p: string): string {
  const parts = p.split('/')
  return parts.length <= 2 ? p : '…/' + parts.slice(-2).join('/')
}
