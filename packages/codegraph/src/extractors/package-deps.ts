// ADR-005
/**
 * Package Deps Hygiene Extractor — structural map phase 3.8 #7
 *
 * Compare les imports externes observés dans le code aux déclarations des
 * `package.json` découverts (recherche récursive depuis `rootDir`,
 * node_modules / dist / build exclus). Chaque fichier est rattaché au
 * `package.json` le plus proche dans son arborescence parent.
 *
 * Quatre catégories de mismatch :
 *   - `declared-unused`        : listé dans deps mais jamais importé. SAFE.
 *   - `declared-runtime-asset` : listé, pas d'import statique, MAIS le code
 *                                réfère `node_modules/<pkg>/...` via un path
 *                                runtime. NE PAS UNINSTALL.
 *   - `missing`                : importé mais absent. Casse le build prod.
 *   - `devOnly`                : importé seulement par tests, déclaré en deps
 *                                au lieu de devDependencies.
 *
 * Le kind `declared-runtime-asset` (ajouté 2026-04-29) ferme un angle mort
 * majeur : codegraph ne voit que les imports statiques. Les patterns
 * runtime asset (`new URL('node_modules/p5/lib/p5.min.js', import.meta.url)`,
 * `readFile('node_modules/X/...')`) sont invisibles. Cas vécu Sentinel :
 * uninstall p5 sur la base d'un faux positif DEP-UNUSED → tous les renders
 * fail ENOENT en prod.
 *
 * Limites v1 :
 *   - TS path mapping — `@/foo`, `~/bar`, `#internal` filtrés heuristiquement
 *     par préfixe, sans lire tsconfig.compilerOptions.paths.
 *   - Type-only imports (`import type {…} from 'pkg'`) sont comptés comme
 *     imports runtime. Conséquence : `@types/*` n'est jamais flaggé
 *     `declared-unused` (filtre explicite pour éviter les faux positifs).
 *   - Imports dynamiques (`import('pkg')`) non capturés.
 *   - Workspaces npm/yarn/pnpm non résolus : chaque `package.json` découvert
 *     est traité comme un scope indépendant.
 *   - Runtime asset detection : regex sur le texte source. Faux positifs
 *     possibles si `node_modules/X` apparaît dans un commentaire / string
 *     littéral non-asset. Trade-off accepté : mieux vaut conservateur.
 */

import { Project, type SourceFile, Node, SyntaxKind } from 'ts-morph'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { builtinModules } from 'node:module'
import type { PackageDepsIssue } from '../core/types.js'

export interface PackageDepsOptions {
  /** Regex identifiant un fichier test. Defaults : *.test.ts, *.spec.ts, tests/, __tests__/. */
  testPatterns?: RegExp[]
}

type DepBlock = 'dependencies' | 'devDependencies' | 'peerDependencies'

interface PackageManifest {
  abs: string
  rel: string
  dir: string
  declared: Map<string, DepBlock>
  /**
   * Texte concaténé des `scripts` (npm scripts) du manifest. Servir au
   * matching `script-asset` : un package mentionné dans une script CLI
   * (`tsc`, `vitest`, `eslint`) est used, pas declared-unused.
   */
  scriptsText: string
}

const NODE_BUILTINS = new Set<string>(builtinModules)

const DEFAULT_TEST_RES: RegExp[] = [
  /\.test\.tsx?$/,
  /\.spec\.tsx?$/,
  /(^|\/)tests?\//,
  /(^|\/)__tests__\//,
]

export async function analyzePackageDeps(
  rootDir: string,
  files: string[],
  project: Project,
  options: PackageDepsOptions = {},
): Promise<PackageDepsIssue[]> {
  const testREs = options.testPatterns ?? DEFAULT_TEST_RES

  const manifests = await discoverManifests(rootDir)
  if (manifests.length === 0) return []

  // Tri décroissant par longueur de `dir` pour que `findClosest` prenne le
  // premier match = ancêtre le plus proche.
  manifests.sort((a, b) => b.dir.length - a.dir.length)

  // Filtrer les manifests qui n'ont aucun fichier source dans leur scope :
  // éviterait un faux positif « déclarations toutes unused » pour un
  // package.json situé dans un dossier exclu de l'analyse.
  const scopeFileCount = new Map<string, number>()
  for (const m of manifests) scopeFileCount.set(m.abs, 0)
  for (const rel of files) {
    const abs = path.join(rootDir, rel)
    const m = findClosestManifest(abs, manifests)
    if (m) scopeFileCount.set(m.abs, (scopeFileCount.get(m.abs) ?? 0) + 1)
  }
  const active = manifests.filter((m) => (scopeFileCount.get(m.abs) ?? 0) > 0)
  if (active.length === 0) return []

  const fileSet = new Set(files)

  // importsByManifest : manifest.abs → Map<packageName, Set<file>>
  const importsByManifest = new Map<string, Map<string, Set<string>>>()
  // runtimeAssetsByManifest : manifest.abs → Map<packageName, Set<file>>
  // Détecté via regex `node_modules/<pkg>/` dans le source — pour identifier
  // les deps utilisées en runtime asset (p5.min.js, etc.) et éviter de les
  // flagger declared-unused à tort.
  const runtimeAssetsByManifest = new Map<string, Map<string, Set<string>>>()
  for (const m of active) {
    importsByManifest.set(m.abs, new Map())
    runtimeAssetsByManifest.set(m.abs, new Map())
  }

  for (const sf of project.getSourceFiles()) {
    const absPath = sf.getFilePath() as string
    const relPath = path.relative(rootDir, absPath).replace(/\\/g, '/')
    if (!fileSet.has(relPath)) continue

    const manifest = findClosestManifest(absPath, active)
    if (!manifest) continue

    const refs = collectPackageRefsInSourceFile(sf)
    const importBucket = importsByManifest.get(manifest.abs)!
    for (const pkg of refs.imports) {
      if (!importBucket.has(pkg)) importBucket.set(pkg, new Set())
      importBucket.get(pkg)!.add(relPath)
    }
    const assetBucket = runtimeAssetsByManifest.get(manifest.abs)!
    for (const pkg of refs.runtimeAssets) {
      if (!assetBucket.has(pkg)) assetBucket.set(pkg, new Set())
      assetBucket.get(pkg)!.add(relPath)
    }
  }

  return buildPackageDepsIssues(active, importsByManifest, runtimeAssetsByManifest, testREs)
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function discoverManifests(rootDir: string): Promise<PackageManifest[]> {
  const out: PackageManifest[] = []
  await walkForManifests(rootDir, rootDir, out)
  return out
}

async function walkForManifests(
  dir: string,
  rootDir: string,
  acc: PackageManifest[],
): Promise<void> {
  const dirName = path.basename(dir)
  const skip = new Set([
    'node_modules', '.git', 'dist', 'build', '.next',
    'coverage', '.turbo', '.cache',
  ])
  if (skip.has(dirName) && dir !== rootDir) return

  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  // Process package.json files séquentiellement (peu nombreux par dir),
  // récurse sub-dirs en parallèle (push partagé OK en JS single-thread).
  const subdirs: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isFile() && entry.name === 'package.json') {
      try {
        // await-ok: 1 package.json par dir typiquement, séquentiel acceptable
        const raw = JSON.parse(await fs.readFile(full, 'utf-8'))
        const declared = new Map<string, DepBlock>()
        for (const name of Object.keys(raw.dependencies ?? {})) {
          declared.set(name, 'dependencies')
        }
        for (const name of Object.keys(raw.devDependencies ?? {})) {
          if (!declared.has(name)) declared.set(name, 'devDependencies')
        }
        for (const name of Object.keys(raw.peerDependencies ?? {})) {
          if (!declared.has(name)) declared.set(name, 'peerDependencies')
        }
        const scriptsText = Object.values(raw.scripts ?? {})
          .filter((v): v is string => typeof v === 'string')
          .join(' \n ')
        acc.push({
          abs: full,
          rel: path.relative(rootDir, full).replace(/\\/g, '/'),
          dir,
          declared,
          scriptsText,
        })
      } catch {
        // JSON invalide — skip silencieusement.
      }
    } else if (entry.isDirectory()) {
      subdirs.push(full)
    }
  }
  await Promise.all(subdirs.map((sd) => walkForManifests(sd, rootDir, acc)))
}

function findClosestManifest(
  filePath: string,
  manifests: PackageManifest[],
): PackageManifest | null {
  // Précondition : manifests trié par `dir.length` décroissant.
  const sep = path.sep
  for (const m of manifests) {
    if (filePath === m.dir) return m
    if (filePath.startsWith(m.dir + sep)) return m
  }
  return null
}

/**
 * Détecte la directive `@ts-nocheck` au file-level (commentaire dans les
 * 5 premières lignes non-vides). Les fixtures de codegraph (truth-points
 * orm-drizzle, orm-prisma) l'utilisent comme marqueur "stub data, pas de
 * runtime" — leurs imports doivent être ignorés par package-deps.
 */
function hasTsNocheckDirective(sf: SourceFile): boolean {
  const text = sf.getFullText()
  const head = text.split('\n').slice(0, 20).join('\n')
  return /\/\/\s*@ts-nocheck\b/.test(head) || /\/\*[^*]*@ts-nocheck\b/.test(head)
}

function collectImportSpecifiers(sf: SourceFile): string[] {
  const specs: string[] = []
  for (const decl of sf.getImportDeclarations()) {
    specs.push(decl.getModuleSpecifierValue())
  }
  for (const decl of sf.getExportDeclarations()) {
    const ms = decl.getModuleSpecifierValue()
    if (ms) specs.push(ms)
  }
  // Tier 17 self-audit fix : capture les imports dynamiques.
  //   - `await import('pkg')` → CallExpression dont expression.kind === ImportKeyword
  //   - `require.resolve('pkg')` → CallExpression dont expression matches `require.resolve`
  //   - `require('pkg')` (CommonJS) → CallExpression dont expression === 'require'
  // Sans ca, l'extractor classait des deps utilisees en "declared-unused" (5 FP
  // sur le toolkit lui-meme : serve-handler, @liby-tools/datalog, etc.).
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression()
    let isDynImport = false
    // `import('pkg')` — l'expression est un ImportKeyword (kind=100).
    if (callee.getKind() === SyntaxKind.ImportKeyword) isDynImport = true
    // `require('pkg')` ou `require.resolve('pkg')`
    else if (Node.isIdentifier(callee) && callee.getText() === 'require') isDynImport = true
    else if (Node.isPropertyAccessExpression(callee)) {
      const text = callee.getText()
      if (text === 'require.resolve' || text === 'require') isDynImport = true
    }
    if (!isDynImport) continue
    const args = call.getArguments()
    if (args.length === 0) continue
    const arg0 = args[0]
    if (Node.isStringLiteral(arg0) || Node.isNoSubstitutionTemplateLiteral(arg0)) {
      specs.push(arg0.getLiteralValue())
    }
  }
  return specs
}

/**
 * Helper réutilisable pour la migration Salsa : pour UN SourceFile,
 * retourne la liste des packages externes importés (déjà normalisés)
 * + la liste des packages référencés en runtime asset.
 *
 * Pas de matching contre les manifests ici — c'est le rôle de
 * l'agrégateur. Cette séparation permet de cacher le scan AST par
 * fichier indépendamment de la structure des manifests.
 */
export function collectPackageRefsInSourceFile(sf: SourceFile): {
  imports: string[]
  runtimeAssets: string[]
} {
  // Fichiers `@ts-nocheck` = stubs / fixtures opt-out du type checking.
  // Leurs imports sont déclaratifs (alimentent un extracteur, p.ex.
  // truth-points orm-drizzle/orm-prisma), pas runtime. Les inclure
  // produit des FP `missing` sur des packages que le code de prod
  // n'importe jamais (cf. self-audit codegraph 2026-05).
  if (hasTsNocheckDirective(sf)) return { imports: [], runtimeAssets: [] }

  const importSet = new Set<string>()
  for (const spec of collectImportSpecifiers(sf)) {
    const pkg = normalizePackageName(spec)
    if (pkg) importSet.add(pkg)
  }
  const assets = collectRuntimeAssetReferences(sf)
  return {
    imports: [...importSet].sort(),
    runtimeAssets: [...assets].sort(),
  }
}

export type { PackageManifest, DepBlock }
export {
  discoverManifests,
  findClosestManifest,
  DEFAULT_TEST_RES,
  buildPackageDepsIssues,
}

/**
 * Construit les `PackageDepsIssue[]` à partir des manifests + map
 * `manifest.abs → fichier → {imports, runtimeAssets}`. Pure logique
 * (matching declared vs imported), réutilisable côté Salsa.
 *
 * Précondition : `manifests` est l'output de `discoverManifests()`,
 * filtré aux active (au moins 1 fichier dans leur scope).
 */
function buildPackageDepsIssues(
  active: PackageManifest[],
  importsByManifest: Map<string, Map<string, Set<string>>>,
  runtimeAssetsByManifest: Map<string, Map<string, Set<string>>>,
  testREs: RegExp[],
): PackageDepsIssue[] {
  const issues: PackageDepsIssue[] = []

  for (const m of active) {
    const imports = importsByManifest.get(m.abs)!
    const runtimeAssets = runtimeAssetsByManifest.get(m.abs)!
    const importedNames = new Set(imports.keys())

    for (const [name, block] of m.declared) {
      if (importedNames.has(name)) continue
      if (name.startsWith('@types/')) continue
      const runtimeRefs = runtimeAssets.get(name)
      if (runtimeRefs && runtimeRefs.size > 0) {
        issues.push({
          kind: 'declared-runtime-asset',
          packageName: name,
          packageJson: m.rel,
          importers: [],
          declaredIn: block,
          runtimeAssetReferences: [...runtimeRefs].sort(),
        })
      } else if (isReferencedInScripts(name, m.scriptsText)) {
        // Le package est invoqué via npm script (ex: `tsc -b`, `vitest run`).
        // Pas un import, mais usage légitime — skip le flag.
      } else {
        issues.push({
          kind: 'declared-unused',
          packageName: name,
          packageJson: m.rel,
          importers: [],
          declaredIn: block,
        })
      }
    }

    for (const [name, importers] of imports) {
      const block = m.declared.get(name)
      const importersList = [...importers].sort()
      const testOnly = importersList.every((f) => testREs.some((r) => r.test(f)))

      if (!block) {
        issues.push({
          kind: 'missing',
          packageName: name,
          packageJson: m.rel,
          importers: importersList,
        })
      } else if (block === 'dependencies' && testOnly) {
        issues.push({
          kind: 'devOnly',
          packageName: name,
          packageJson: m.rel,
          importers: importersList,
          testImporters: importersList,
          declaredIn: block,
        })
      }
    }
  }

  issues.sort((a, b) => {
    if (a.packageJson !== b.packageJson) return a.packageJson < b.packageJson ? -1 : 1
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1
    return a.packageName < b.packageName ? -1 : a.packageName > b.packageName ? 1 : 0
  })

  return issues
}

/**
 * Mapping pkgname → noms binaires courants. Pour un pkg dont le bin name
 * diffère du package name (ex: `typescript` → `tsc`), un script qui
 * appelle le binaire ne mentionne pas le pkgname. Cette table couvre
 * les cas qu'on rencontre en pratique (build/test/lint tooling).
 *
 * Liste minimale par design : on ajoute uniquement les pkg dont le bin
 * diffère ET qu'on rencontre dans des scripts npm. Les autres (`vitest`,
 * `eslint`, `prettier`) ont bin = pkgname et sont matchés directement.
 */
const PKG_BIN_ALIASES: Record<string, readonly string[]> = {
  typescript: ['tsc', 'tsserver'],
  '@types/node': [], // jamais en script
  '@biomejs/biome': ['biome'],
  '@vitejs/plugin-react': [],
}

/**
 * Vrai si `name` apparaît dans `scriptsText` soit comme pkgname soit
 * comme un de ses bin aliases. Match conservateur : whole-word boundary
 * pour éviter qu'un nom court (ex: `tsx`) matche `tsxxx`.
 */
function isReferencedInScripts(name: string, scriptsText: string): boolean {
  if (!scriptsText) return false
  // Match pkgname tel quel (whole word, autorise / et @ pour scoped pkgs).
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const reName = new RegExp(`(^|[\\s;&|=()'"\`])${escaped}([\\s;&|=()'"\`]|$)`, 'm')
  if (reName.test(scriptsText)) return true
  // Match bin aliases si configurés.
  const bins = PKG_BIN_ALIASES[name]
  if (bins) {
    for (const bin of bins) {
      const reBin = new RegExp(`(^|[\\s;&|=()'"\`])${bin}([\\s;&|=()'"\`]|$)`, 'm')
      if (reBin.test(scriptsText)) return true
    }
  }
  return false
}

/**
 * Détecte les noms de packages référencés via des paths runtime
 * (`node_modules/<pkg>/...`). Couvre les patterns vus dans Sentinel :
 *   - `new URL('../../node_modules/p5/lib/p5.min.js', import.meta.url)`
 *   - `readFile('node_modules/X/dist/foo.js')`
 *   - `path.join(..., 'node_modules', 'X', ...)`  ← partial, regex string only
 *
 * Conservateur : on regex le **texte source brut** plutôt que d'analyser
 * sémantiquement. Faux positifs OK (un package mentionné dans un commentaire
 * sera flagué `declared-runtime-asset` au lieu de `declared-unused` —
 * downgrade safe). Faux négatifs minimisés : tout `node_modules/<name>` ou
 * `node_modules', '<name>` détecté.
 */
function collectRuntimeAssetReferences(sf: SourceFile): Set<string> {
  const found = new Set<string>()
  const text = sf.getFullText()
  // Pattern A : node_modules/<pkg>/...  ou  node_modules\\<pkg>\\...
  // <pkg> peut être @scope/name ou name simple.
  const reSlash = /node_modules[/\\]((?:@[a-z0-9._-]+[/\\])?[a-z0-9._-]+)/gi
  let m: RegExpExecArray | null
  while ((m = reSlash.exec(text)) !== null) {
    const pkg = m[1]!.replace(/\\/g, '/').replace(/\/$/, '')
    // Normalize @scope\name → @scope/name (regex captures with separator)
    if (pkg.startsWith('@') && !pkg.includes('/')) continue        // malformé
    found.add(pkg)
  }
  // Pattern B : 'node_modules', '<pkg>' (path.join style)
  const reJoin = /['"`]node_modules['"`]\s*,\s*['"`](@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)['"`]/gi
  while ((m = reJoin.exec(text)) !== null) {
    found.add(m[1]!)
  }
  // Pattern C : `npx <pkgname>` shell-out (CLI tools qui appellent un autre
  // binaire). Le pkg est listé en `dependencies` mais jamais importé. Sans
  // ce pattern, le detector flag `declared-unused` à tort (cf. adr-toolkit
  // qui shell-out `npx @liby-tools/codegraph` dans ses hooks/init).
  // Capture aussi `pnpm dlx` et `yarn dlx` (équivalents npm).
  const reShellOut = /\b(?:npx|pnpm dlx|yarn dlx)\s+(@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)\b/gi
  while ((m = reShellOut.exec(text)) !== null) {
    found.add(m[1]!)
  }
  return found
}

/**
 * `lodash`           → `lodash`
 * `lodash/fp`        → `lodash`
 * `@scope/pkg`       → `@scope/pkg`
 * `@scope/pkg/sub`   → `@scope/pkg`
 * `./foo`            → null (relatif)
 * `node:fs` / `fs`   → null (builtin)
 * `@/utils`          → null (alias TS)
 * `~/foo` / `#sub`   → null
 */
function normalizePackageName(spec: string): string | null {
  if (!spec || spec.startsWith('.')) return null
  if (spec.startsWith('node:')) return null
  if (spec.startsWith('~') || spec.startsWith('#')) return null

  const firstSegment = spec.split('/')[0]!
  if (NODE_BUILTINS.has(firstSegment)) return null

  if (spec.startsWith('@')) {
    const m = spec.match(/^(@[^/]+\/[^/]+)(?:\/.*)?$/)
    if (!m) return null  // `@/foo` (pas de scope) → alias
    return m[1]!
  }

  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(firstSegment)) return null
  return firstSegment
}
