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
    tsConfigFilePath: tsConfigPath,
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
    } catch {
      // Skip unparseable files
    }
  }
  return project
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

  // ─── 2. Build source import map ───────────────────────────────────

  // Map: "file:symbolName" → Set of importing source files
  const importUsageMap = new Map<string, Set<string>>()
  // Map: file → Set of namespace importers
  const namespaceImporters = new Map<string, Set<string>>()

  for (const sourceFile of project.getSourceFiles()) {
    const importerPath = relativize(sourceFile.getFilePath(), rootDir)
    if (!importerPath) continue

    for (const imp of sourceFile.getImportDeclarations()) {
      const targetFile = imp.getModuleSpecifierSourceFile()
      if (!targetFile) continue
      const targetPath = relativize(targetFile.getFilePath(), rootDir)
      if (!targetPath) continue

      const nsImport = imp.getNamespaceImport()
      if (nsImport) {
        if (!namespaceImporters.has(targetPath)) namespaceImporters.set(targetPath, new Set())
        namespaceImporters.get(targetPath)!.add(importerPath)
        continue
      }

      const defaultImport = imp.getDefaultImport()
      if (defaultImport) {
        const key = `${targetPath}:default`
        if (!importUsageMap.has(key)) importUsageMap.set(key, new Set())
        importUsageMap.get(key)!.add(importerPath)
      }

      for (const named of imp.getNamedImports()) {
        const name = named.getName()
        const key = `${targetPath}:${name}`
        if (!importUsageMap.has(key)) importUsageMap.set(key, new Set())
        importUsageMap.get(key)!.add(importerPath)
      }
    }

    for (const exp of sourceFile.getExportDeclarations()) {
      const targetFile = exp.getModuleSpecifierSourceFile()
      if (!targetFile) continue
      const targetPath = relativize(targetFile.getFilePath(), rootDir)
      if (!targetPath) continue

      if (!exp.getNamedExports().length && exp.isNamespaceExport()) {
        if (!namespaceImporters.has(targetPath)) namespaceImporters.set(targetPath, new Set())
        namespaceImporters.get(targetPath)!.add(importerPath)
        continue
      }

      for (const named of exp.getNamedExports()) {
        const name = named.getName()
        const key = `${targetPath}:${name}`
        if (!importUsageMap.has(key)) importUsageMap.set(key, new Set())
        importUsageMap.get(key)!.add(importerPath)
      }
    }

    // ─── Dynamic imports : `await import('./path.js')` ───
    //
    // Fix M-003 : le detector ne voyait que les imports statiques. Les
    // consumers lazy (webhook handlers, routes, tests) chargent via
    // `await import(...)` avec string littérale — leurs cibles étaient
    // faussement marquées "safe-to-remove".
    //
    // Résolution : seul le cas `specifier` = string literal est tracé.
    // Les template strings avec `${…}` sortent encore en "possibly-dynamic"
    // via le pass heuristique existant (section 4).
    for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = callExpr.getExpression()
      if (expr.getText() !== 'import') continue

      const args = callExpr.getArguments()
      if (args.length === 0) continue

      const firstArg = args[0]
      if (!Node.isStringLiteral(firstArg) && !Node.isNoSubstitutionTemplateLiteral(firstArg)) continue

      const specifier = firstArg.getLiteralValue()
      if (!specifier.startsWith('.')) continue // skip bare/alias pour l'instant — rare en dynamic

      const targetPath = resolveDynamicImport(specifier, sourceFile, rootDir, project)
      if (!targetPath) continue

      // Chaîne parent : CallExpression → [AwaitExpression] → VariableDeclaration
      let parent: Node | undefined = callExpr.getParent()
      if (parent && Node.isAwaitExpression(parent)) parent = parent.getParent()

      if (parent && Node.isVariableDeclaration(parent)) {
        const nameNode = parent.getNameNode()

        if (Node.isObjectBindingPattern(nameNode)) {
          // const { X, Y: Alias } = await import('...')
          for (const element of nameNode.getElements()) {
            const propNameNode = element.getPropertyNameNode()
            const name = propNameNode ? propNameNode.getText() : element.getNameNode().getText()
            const key = `${targetPath}:${name}`
            if (!importUsageMap.has(key)) importUsageMap.set(key, new Set())
            importUsageMap.get(key)!.add(importerPath)
          }
          continue
        }

        if (Node.isIdentifier(nameNode)) {
          // const mod = await import('...') → équivalent namespace
          if (!namespaceImporters.has(targetPath)) namespaceImporters.set(targetPath, new Set())
          namespaceImporters.get(targetPath)!.add(importerPath)
          continue
        }
      }

      // Cas non-destructuré (callback .then, expression inline) : conservateur,
      // on marque le fichier cible comme namespace-consommé pour ne pas
      // produire de faux "safe-to-remove".
      if (!namespaceImporters.has(targetPath)) namespaceImporters.set(targetPath, new Set())
      namespaceImporters.get(targetPath)!.add(importerPath)
    }
  }

  // ─── 3. Scan test files with lightweight regex (no second ts-morph) ─

  const testFiles = await discoverTestFiles(rootDir)
  // Map: symbolName → Set of test files that reference it
  const testSymbolHits = new Map<string, Set<string>>()
  // Map: sourceFileBasename → Set of test files importing from it
  const testFileImports = new Map<string, Set<string>>()

  // Regex 1 : import statique — `import { X, Y } from '...'` ou `import X from '...'`
  const importRegex = /import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+['"]([^'"]+)['"]/g
  // Regex 2 : dynamic import — `const { X, Y } = await import('...')` ou `const X = await import('...')`
  //
  // Fix M-006 : sans ce deuxième regex, les tests qui chargent leur module
  // cible en dynamic import (pattern très utilisé pour lazy-load + mock)
  // n'étaient pas vus. Leurs symboles restaient classés safe-to-remove.
  const dynamicImportRegex = /(?:const|let|var)\s+(?:\{([^}]+)\}|(\w+))\s*=\s*await\s+import\s*\(\s*['"]([^'"]+)['"]\s*\)/g

  const processImportMatch = (
    namedImports: string | undefined,
    identifierImport: string | undefined,
    modulePath: string,
    testFile: string,
  ) => {
    const basename = modulePath.split('/').pop()?.replace(/\.(js|ts|tsx)$/, '') || ''
    if (basename) {
      if (!testFileImports.has(basename)) testFileImports.set(basename, new Set())
      testFileImports.get(basename)!.add(testFile)
    }

    if (namedImports) {
      for (const part of namedImports.split(',')) {
        // Gère `X: Alias` (rename destructuring) et `X as Alias` (import rename)
        const symbolName = part.trim().split(/\s*[:]|\s+as\s+/)[0].trim()
        if (symbolName) {
          if (!testSymbolHits.has(symbolName)) testSymbolHits.set(symbolName, new Set())
          testSymbolHits.get(symbolName)!.add(testFile)
        }
      }
    }
    if (identifierImport) {
      if (!testSymbolHits.has(identifierImport)) testSymbolHits.set(identifierImport, new Set())
      testSymbolHits.get(identifierImport)!.add(testFile)
    }
  }

  for (const testFile of testFiles) {
    const absPath = path.join(rootDir, testFile)
    let content: string
    try {
      content = await fs.readFile(absPath, 'utf-8')
    } catch { continue }

    let match
    importRegex.lastIndex = 0
    while ((match = importRegex.exec(content)) !== null) {
      processImportMatch(match[1], match[2], match[3], testFile)
    }

    dynamicImportRegex.lastIndex = 0
    while ((match = dynamicImportRegex.exec(content)) !== null) {
      processImportMatch(match[1], match[2], match[3], testFile)
    }
  }

  // ─── 4. Build dynamic usage index ─────────────────────────────────
  // Scan all source files for symbol names appearing in string literals,
  // template literals, object keys, and known dynamic patterns.

  const dynamicSymbolHits = new Set<string>() // symbol names found in dynamic contexts

  for (const sourceFile of project.getSourceFiles()) {
    const text = sourceFile.getFullText()

    // Patterns that suggest dynamic symbol usage:
    // - String literals containing the symbol name (e.g., in TOOL_SCHEMAS, registries)
    // - Object property access via bracket notation: obj['symbolName']
    // - Template literals: `${prefix}SymbolName`
    // We collect candidate symbol names from strings in this file
    const stringMatches = text.match(/['"`]([A-Za-z_$][A-Za-z0-9_$]*(?:Schema|Params|Handler|Action|Event|Type|Config)?)['"` ]/g)
    if (stringMatches) {
      for (const m of stringMatches) {
        const clean = m.replace(/['"`\s]/g, '')
        if (clean.length > 2) dynamicSymbolHits.add(clean)
      }
    }
  }

  // ─── 5. Extract exports and classify ──────────────────────────────

  const results: FileExportInfo[] = []

  for (const sourceFile of project.getSourceFiles()) {
    const filePath = relativize(sourceFile.getFilePath(), rootDir)
    if (!filePath) continue
    if (!files.includes(filePath)) continue

    const fileExports: ExportSymbol[] = []
    const nsUsers = namespaceImporters.get(filePath) || new Set<string>()
    const fileText = sourceFile.getFullText()

    for (const [name, declarations] of sourceFile.getExportedDeclarations()) {
      for (const decl of declarations) {
        const kind = classifyDeclaration(decl)
        const line = decl.getStartLineNumber()
        const isReExport = decl.getSourceFile() !== sourceFile
        const symbolName = name === 'default' ? '(default)' : name

        // Source usage
        const key = name === 'default' ? `${filePath}:default` : `${filePath}:${name}`
        const directUsers = importUsageMap.get(key) || new Set<string>()
        const allUsers = new Set([...directUsers, ...nsUsers])
        allUsers.delete(filePath)

        // Test usage (lightweight regex-based)
        const testHits = name !== 'default' ? (testSymbolHits.get(name) || new Set<string>()) : new Set<string>()
        // Also check if any test imports from this file's basename
        const fileBasename = path.basename(filePath).replace(/\.(ts|tsx|js|jsx)$/, '')
        const testFileHits = testFileImports.get(fileBasename) || new Set<string>()
        const allTestUsers = new Set([...testHits])

        // Classify confidence
        let confidence: ExportConfidence = 'used'
        let reason: string | undefined

        if (allUsers.size > 0 || isReExport) {
          confidence = 'used'
        } else if (isNextJsFrameworkExport(filePath, name)) {
          // Fix M-008 : conventions Next.js (default page/layout, metadata,
          // viewport, route segment config, etc.) lues par réflexion par le
          // runtime Next. Pas un dead export.
          confidence = 'used'
          reason = 'Next.js framework convention export (read reflectively by runtime)'
        } else if (isToolConfigExport(filePath, name)) {
          // Fix M-010 : fichiers de config outillage (vitest.config, tailwind.config,
          // etc.) — le `default` export est lu par le runner, pas par du code TS.
          confidence = 'used'
          reason = 'Tool config (read by runner)'
        } else if (allTestUsers.size > 0) {
          confidence = 'test-only'
          reason = `imported by ${allTestUsers.size} test file(s): ${[...allTestUsers].slice(0, 3).map(f => shortPath(f)).join(', ')}`
        } else if (name !== 'default' && dynamicSymbolHits.has(name)) {
          confidence = 'possibly-dynamic'
          reason = `symbol name "${name}" found in string literals (possible dynamic lookup)`
        } else if (name !== 'default' && isUsedLocallyOnly(fileText, name, line)) {
          confidence = 'local-only'
          reason = `referenced in same file but not imported elsewhere — remove \`export\` keyword`
        } else if (allUsers.size === 0 && !isReExport) {
          confidence = 'safe-to-remove'
          reason = 'no imports in source, tests, or dynamic patterns'
        }

        fileExports.push({
          name: symbolName,
          kind,
          line,
          usageCount: allUsers.size,
          usedBy: allUsers.size > 0 ? [...allUsers].sort() : undefined,
          reExport: isReExport || undefined,
          confidence,
          reason,
        })
      }
    }

    if (fileExports.length > 0) {
      const unusedCount = fileExports.filter(e => e.usageCount === 0 && !e.reExport).length

      // Count by confidence
      const byConfidence: Record<ExportConfidence, number> = {
        'used': 0, 'test-only': 0, 'possibly-dynamic': 0, 'local-only': 0, 'safe-to-remove': 0,
      }
      for (const e of fileExports) {
        if (e.confidence) byConfidence[e.confidence]++
      }

      results.push({
        file: filePath,
        exports: fileExports.sort((a, b) => a.line - b.line),
        unusedCount,
        totalCount: fileExports.length,
        byConfidence,
      })
    }
  }

  return results
}

// ─── Test File Discovery ────────────────────────────────────────────

async function discoverTestFiles(rootDir: string): Promise<string[]> {
  const testFiles: string[] = []
  // Fix M-007 : les tests unitaires vivent dans `<pkg>/tests/` (tsx + vitest
  // config), pas seulement dans `<pkg>/src/`. Sans scan de ces répertoires,
  // tous les exports consommés uniquement par ces tests étaient faussement
  // classés safe-to-remove.
  const testDirs = [
    'sentinel-core/src',
    'sentinel-core/tests',
    'sentinel-web/src',
    'sentinel-web/tests',
  ]

  for (const dir of testDirs) {
    const fullDir = path.join(rootDir, dir)
    try {
      await walkForTests(fullDir, rootDir, testFiles)
    } catch {
      // Directory might not exist
    }
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

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkForTests(fullPath, rootDir, result)
    } else if (entry.isFile()) {
      const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/')
      if (isTestFile(relativePath)) {
        result.push(relativePath)
      }
    }
  }
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

// ─── Next.js Framework Convention Exports ──────────────────────────────
//
// Fix M-008 : les fichiers de routing Next.js App Router exposent plusieurs
// exports nommés que le runtime lit par réflexion (metadata, viewport, etc.).
// Ils ne sont jamais importés par du code applicatif, donc le detector les
// classait systématiquement safe-to-remove — polluant la liste avec ~10
// faux positifs par projet Next.js.
//
// La whitelist est hard-codée : ces noms sont dictés par Next.js, pas par
// le projet. Si un jour on voulait la rendre configurable, un champ
// `frameworkExports[]` dans la config codegraph serait le bon endroit.
//
// Références :
//   https://nextjs.org/docs/app/api-reference/file-conventions/metadata
//   https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config

const NEXTJS_CONVENTION_EXPORTS = new Set([
  // Metadata API
  'metadata', 'generateMetadata',
  'viewport', 'generateViewport',
  // Route segment config
  'dynamic', 'dynamicParams', 'revalidate', 'fetchCache',
  'runtime', 'preferredRegion', 'maxDuration', 'experimental_ppr',
  // generateStaticParams pour les segments dynamiques
  'generateStaticParams',
  // Image/icon conventions (opengraph-image, twitter-image, icon, apple-icon)
  'alt', 'size', 'contentType',
])

const NEXTJS_ROUTE_BASENAMES = new Set([
  'page', 'layout', 'template', 'loading', 'error',
  'global-error', 'not-found', 'default', 'route',
  // Root-level conventions
  'middleware', 'instrumentation',
  // Metadata files
  'opengraph-image', 'twitter-image', 'icon', 'apple-icon', 'sitemap', 'robots', 'manifest',
])

/**
 * Un fichier est "route Next.js" si son basename correspond à une convention
 * (page, layout, route, middleware, etc.) ET qu'il est sous un répertoire
 * `app/` (App Router).
 */
function isNextJsRouteFile(filePath: string): boolean {
  const inAppRouter = filePath.includes('/app/') || filePath.startsWith('app/')
  // middleware.ts et instrumentation.ts vivent à la racine de `src/` ou du
  // projet — pas sous `app/`. On accepte n'importe où pour ces deux-là.
  const basenameNoExt = (filePath.split('/').pop() ?? filePath).replace(/\.(ts|tsx|js|jsx)$/, '')
  if (basenameNoExt === 'middleware' || basenameNoExt === 'instrumentation') return true
  if (!inAppRouter) return false
  return NEXTJS_ROUTE_BASENAMES.has(basenameNoExt)
}

/**
 * Un export convention Next.js n'est pas "unused" même si personne ne l'importe —
 * le runtime Next le lit par réflexion depuis les fichiers de route.
 * Couvre :
 *   - le `default` export (la page / layout / route handler lui-même)
 *   - les exports nommés conventionnels (metadata, viewport, dynamic, etc.)
 */
function isNextJsFrameworkExport(filePath: string, symbolName: string): boolean {
  if (!isNextJsRouteFile(filePath)) return false
  if (symbolName === 'default') return true
  return NEXTJS_CONVENTION_EXPORTS.has(symbolName)
}

// ─── Tool Config Files (vitest / vite / jest / tailwind / postcss / next) ──
//
// Fix M-010 : les fichiers de config outillage (`vitest.config.ts`,
// `tailwind.config.ts`, etc.) exportent typiquement un `default` lu par
// le runner/tooling — jamais importé par du code applicatif. Sans
// whitelist, le detector les classait safe-to-remove.
//
// Même esprit que M-008 (Next.js conventions) : le symbole est lu par
// réflexion depuis l'extérieur du graphe TS.

const TOOL_CONFIG_BASENAMES = new Set([
  'vitest.config',
  'vite.config',
  'jest.config',
  'tailwind.config',
  'postcss.config',
  'next.config',
  'playwright.config',
  'drizzle.config',
  'tsup.config',
])

function isToolConfigFile(filePath: string): boolean {
  const basename = filePath.split('/').pop() ?? filePath
  const noExt = basename.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '')
  return TOOL_CONFIG_BASENAMES.has(noExt)
}

/**
 * Le `default` export d'un fichier de config outillage est lu par le
 * runner (vitest, vite, jest, etc.), pas par du code applicatif.
 */
function isToolConfigExport(filePath: string, symbolName: string): boolean {
  if (symbolName !== 'default') return false
  return isToolConfigFile(filePath)
}

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
