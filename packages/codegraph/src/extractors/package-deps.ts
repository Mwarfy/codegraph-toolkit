/**
 * Package Deps Hygiene Extractor — structural map phase 3.8 #7
 *
 * Compare les imports externes observés dans le code aux déclarations des
 * `package.json` découverts (recherche récursive depuis `rootDir`,
 * node_modules / dist / build exclus). Chaque fichier est rattaché au
 * `package.json` le plus proche dans son arborescence parent.
 *
 * Trois catégories de mismatch :
 *   - `declared-unused` : listé dans deps/devDeps/peerDeps mais jamais importé
 *                         dans le scope du manifest.
 *   - `missing`         : importé mais absent de tous les blocs deps (casse le
 *                         build en prod avec `npm install --omit=dev`).
 *   - `devOnly`         : importé uniquement depuis des fichiers de test mais
 *                         déclaré dans `dependencies` au lieu de `devDependencies`.
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
 */

import { Project, type SourceFile } from 'ts-morph'
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
  for (const m of active) importsByManifest.set(m.abs, new Map())

  for (const sf of project.getSourceFiles()) {
    const absPath = sf.getFilePath() as string
    const relPath = path.relative(rootDir, absPath).replace(/\\/g, '/')
    if (!fileSet.has(relPath)) continue

    const manifest = findClosestManifest(absPath, active)
    if (!manifest) continue

    for (const spec of collectImportSpecifiers(sf)) {
      const pkg = normalizePackageName(spec)
      if (!pkg) continue
      const bucket = importsByManifest.get(manifest.abs)!
      if (!bucket.has(pkg)) bucket.set(pkg, new Set())
      bucket.get(pkg)!.add(relPath)
    }
  }

  const issues: PackageDepsIssue[] = []

  for (const m of active) {
    const imports = importsByManifest.get(m.abs)!
    const importedNames = new Set(imports.keys())

    // declared-unused : déclaré mais jamais importé. On exclut `@types/*` qui
    // sont utilisés en type-only (non distinguable v1 — filtre explicite).
    for (const [name, block] of m.declared) {
      if (importedNames.has(name)) continue
      if (name.startsWith('@types/')) continue
      issues.push({
        kind: 'declared-unused',
        packageName: name,
        packageJson: m.rel,
        importers: [],
        declaredIn: block,
      })
    }

    // missing + devOnly
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

  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isFile() && entry.name === 'package.json') {
      try {
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
        acc.push({
          abs: full,
          rel: path.relative(rootDir, full).replace(/\\/g, '/'),
          dir,
          declared,
        })
      } catch {
        // JSON invalide — skip silencieusement.
      }
    } else if (entry.isDirectory()) {
      await walkForManifests(full, rootDir, acc)
    }
  }
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

function collectImportSpecifiers(sf: SourceFile): string[] {
  const specs: string[] = []
  for (const decl of sf.getImportDeclarations()) {
    specs.push(decl.getModuleSpecifierValue())
  }
  for (const decl of sf.getExportDeclarations()) {
    const ms = decl.getModuleSpecifierValue()
    if (ms) specs.push(ms)
  }
  return specs
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
