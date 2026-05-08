// ADR-008, ADR-024
/**
 * TypeScript Import/Export Detector
 *
 * The foundational layer — discovers static import relationships
 * between all TypeScript files in the project.
 *
 * Uses ts-morph to resolve imports to actual file paths,
 * including tsconfig path aliases and index.ts barrel exports.
 */

import { Project, SyntaxKind, type SourceFile } from 'ts-morph'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import type { Detector, DetectorContext, DetectedLink } from '../core/types.js'
import { runPerSourceFileExtractor } from '../parallel/per-source-file-extractor.js'

export class TsImportDetector implements Detector {
  name = 'ts-imports'
  edgeType = 'import' as const
  description = 'Static TypeScript import/export relationships'

  private project: Project | null = null

  async detect(ctx: DetectorContext): Promise<DetectedLink[]> {
    const links: DetectedLink[] = []

    // Sprint 6 — réutiliser le sharedProject pré-construit par le caller
    // si dispo (cf. setPrebuiltProject ci-dessous). Évite le double-parse
    // qui coûtait 7s warm sur Sentinel.
    const sharedProject = prebuiltProject
    let createdProject: Project | null = null

    if (sharedProject !== null) {
      this.project = sharedProject
    } else {
      // Trouve le tsconfig pour résoudre les path aliases.
      let tsConfigPath: string | undefined
      const candidates: string[] = []
      if (ctx.tsconfigPath) {
        candidates.push(
          path.isAbsolute(ctx.tsconfigPath)
            ? ctx.tsconfigPath
            : path.join(ctx.rootDir, ctx.tsconfigPath),
        )
      }
      candidates.push(path.join(ctx.rootDir, 'tsconfig.json'))

      for (const candidate of candidates) {
        try {
          // await-ok: probe avec break sur première match, séquentiel requis
          await fs.access(candidate)
          tsConfigPath = candidate
          break
        } catch {
          // Try next
        }
      }

      createdProject = new Project({
        ...(tsConfigPath ? { tsConfigFilePath: tsConfigPath } : {}),
        skipAddingFilesFromTsConfig: true,
        compilerOptions: {
          allowJs: true,
          resolveJsonModule: true,
        },
      })

      for (const relPath of ctx.files) {
        const absPath = path.join(ctx.rootDir, relPath)
        try {
          createdProject.addSourceFileAtPath(absPath)
        } catch {
          // Skip files that can't be parsed
        }
      }

      this.project = createdProject
    }

    // BSP monoïdal (ADR-024) — extractor pure per-file, fusion ordonnée
    // par sortKey canonique. Project ts-morph reste main thread (non
    // sérialisable cross-thread, cf. ADR-025). Gain Promise.all sur les
    // 175 SourceFiles — overlap I/O / CPU AST scan.
    const project = this.project
    const r = await runPerSourceFileExtractor<{ links: DetectedLink[] }, DetectedLink>({
      project,
      files: ctx.files,
      rootDir: ctx.rootDir,
      extractor: (sf, rel) => ({
        links: scanImportsInSourceFile(sf, rel, project, ctx.rootDir, ctx.files),
      }),
      selectItems: (b) => b.links,
      sortKey: (l) =>
        `${l.from}:${String(l.line ?? 0).padStart(8, '0')}:${l.to}:${l.type}`,
    })
    links.push(...r.items)

    // Si on a créé un Project local, le release pour libérer la RAM.
    // Si on a réutilisé le sharedProject, le laisser intact (il
    // appartient au caller).
    if (createdProject !== null) {
      this.project = null
    }

    return links
  }

  private resolveImport(
    imp: { getModuleSpecifierSourceFile(): SourceFile | undefined; getModuleSpecifierValue(): string; getStartLineNumber(): number },
    rootDir: string
  ): string | null {
    // Try ts-morph resolution first
    const resolved = imp.getModuleSpecifierSourceFile()
    if (resolved) {
      return this.relativize(resolved.getFilePath(), rootDir)
    }

    return null
  }

  private resolveRelativePath(
    specifier: string,
    fromFilePath: string,
    rootDir: string
  ): string | null {
    const dir = path.dirname(fromFilePath)

    // Convention ESM+TS : `import './foo.js'` alors que la source sur disque
    // est `foo.ts`. Le suffixe .js/.jsx doit être STRIP avant de tester les
    // extensions candidates, sinon on construit `foo.js.ts` (impossible).
    const stripped = specifier.replace(/\.(js|jsx|ts|tsx|mjs|cjs)$/, '')

    const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx']

    for (const ext of extensions) {
      const candidate = path.resolve(dir, stripped + ext)
      const rel = this.relativize(candidate, rootDir)
      if (rel && this.project?.getSourceFile(candidate)) {
        return rel
      }
    }

    // Fallback : le spécificateur a déjà la bonne extension (rare avec ESM+TS)
    const direct = path.resolve(dir, specifier)
    const rel = this.relativize(direct, rootDir)
    if (rel && this.project?.getSourceFile(direct)) {
      return rel
    }

    return null
  }

  /**
   * Resolve path aliases like @/ or ~/ by inferring the base directory
   * from the importing file's location in the project.
   */
  private resolveAlias(
    specifier: string,
    fromFilePath: string,
    allFiles: string[]
  ): string | null {
    // Common alias patterns: @/ → src/  within the same sub-project
    const aliasPath = specifier.replace(/^[@~]\//, '')

    // Determine which sub-project the importing file is in
    // e.g., backend/src/foo.ts → backend/src/
    const parts = fromFilePath.split('/')
    let srcIndex = parts.indexOf('src')
    if (srcIndex < 0) return null

    const projectPrefix = parts.slice(0, srcIndex + 1).join('/')
    const candidateBase = `${projectPrefix}/${aliasPath}`

    // Try with common extensions
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']
    for (const ext of extensions) {
      const candidate = candidateBase + ext
      if (allFiles.includes(candidate)) return candidate
    }

    // Try exact match (might already have extension)
    if (allFiles.includes(candidateBase)) return candidateBase

    return null
  }

  private relativize(absPath: string, rootDir: string): string | null {
    const normalized = absPath.replace(/\\/g, '/')
    const rootNormalized = rootDir.replace(/\\/g, '/')

    if (!normalized.startsWith(rootNormalized)) return null

    return normalized.slice(rootNormalized.length + 1)
  }
}

// ─── Project sharing (Sprint 6) ──────────────────────────────────────────────

/**
 * Permet au caller (analyze() en mode incremental) de pré-construire le
 * Project ts-morph et de le faire réutiliser par TsImportDetector.
 * Évite le double-parse qui coûte ~7s sur Sentinel warm.
 *
 * Le détecteur ne possède PAS ce Project — c'est au caller de le gérer
 * (pas de release entre runs).
 */
let prebuiltProject: Project | null = null

export function setTsImportPrebuiltProject(project: Project | null): void {
  prebuiltProject = project
}

// ─── Salsa-friendly helpers ──────────────────────────────────────────────────

/**
 * Helper réutilisable : extrait toutes les arêtes d'import d'UN
 * SourceFile (statiques + dynamiques + re-exports). Réutilisé par la
 * version Salsa (incremental/ts-imports.ts) qui cache le résultat
 * par-fichier.
 *
 * IMPORTANT : `project` doit déjà contenir tous les fichiers de
 * `allFiles` parsés (sinon la résolution `getModuleSpecifierSourceFile`
 * fera des null). En mode Salsa, on passe le sharedProject.
 */
export function scanImportsInSourceFile(
  sourceFile: SourceFile,
  fromPath: string,
  project: Project,
  rootDir: string,
  allFiles: string[],
): DetectedLink[] {
  const links: DetectedLink[] = []
  scanStaticImports(sourceFile, fromPath, project, rootDir, allFiles, links)
  scanDynamicImports(sourceFile, fromPath, project, rootDir, links)
  scanReExports(sourceFile, fromPath, project, rootDir, links)
  return links
}

// ─── Static imports : import ... from '...' ────────────────────────────────

function scanStaticImports(
  sourceFile: SourceFile,
  fromPath: string,
  project: Project,
  rootDir: string,
  allFiles: string[],
  links: DetectedLink[],
): void {
  for (const imp of sourceFile.getImportDeclarations()) {
    const specifier = imp.getModuleSpecifierValue()
    if (isExternalModule(specifier)) {
      maybePushExternalImport(imp, fromPath, rootDir, specifier, links, allFiles)
      continue
    }
    const toPath = resolveLocalImport(imp, specifier, sourceFile, project, rootDir, allFiles, fromPath)
    if (!toPath || toPath.includes('node_modules')) continue
    links.push({
      from: fromPath, to: toPath, type: 'import',
      label: specifier, resolved: true,
      line: imp.getStartLineNumber(),
    })
  }
}

function isExternalModule(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('@/') && !specifier.startsWith('~/')
}

/**
 * Pour un import external (npm package), on émet le link UNIQUEMENT si la
 * source file résolue est dans rootDir et n'est PAS dans node_modules. Sert
 * aux monorepos workspace où `@liby-tools/foo` résout vers packages/foo/src.
 */
function maybePushExternalImport(
  imp: import('ts-morph').ImportDeclaration,
  fromPath: string,
  rootDir: string,
  specifier: string,
  links: DetectedLink[],
  allFiles: readonly string[],
): void {
  const resolved = imp.getModuleSpecifierSourceFile()
  if (!resolved) return
  let rel = relativizeAbs(resolved.getFilePath(), rootDir)
  if (!rel || rel.includes('node_modules')) return
  // Mapping `dist/X.d.ts` → `src/X.ts` quand le source existe dans
  // allFiles. Sans ca, un workspace local dont le `package.json#types`
  // pointe vers `dist/index.d.ts` produit des nodes parasites en
  // `dist/` + `.d.ts` malgre les exclude config (cf. self-audit toolkit
  // 2026-05-09 : packages/{salsa,codegraph,datalog}/dist/index.d.ts en
  // top-hub).
  rel = mapDistToSrcIfPossible(rel, allFiles)
  links.push({
    from: fromPath, to: rel, type: 'import',
    label: specifier, resolved: true,
    line: imp.getStartLineNumber(),
  })
}

/**
 * Si le file resolu vit dans `<pkg>/dist/...` ET qu'un fichier source
 * equivalent existe dans `allFiles` (sous `<pkg>/src/...`), le retourne
 * pour que le graphe pointe vers la source plutot que le build artifact.
 */
function mapDistToSrcIfPossible(rel: string, allFiles: readonly string[]): string {
  if (!rel.includes('/dist/')) return rel
  const allSet = new Set(allFiles)
  const candidates = [
    rel.replace(/\/dist\//, '/src/').replace(/\.d\.mts$/, '.ts'),
    rel.replace(/\/dist\//, '/src/').replace(/\.d\.cts$/, '.ts'),
    rel.replace(/\/dist\//, '/src/').replace(/\.d\.ts$/, '.ts'),
    rel.replace(/\/dist\//, '/src/').replace(/\.d\.ts$/, '.tsx'),
    rel.replace(/\/dist\//, '/src/').replace(/\.mjs$/, '.ts'),
    rel.replace(/\/dist\//, '/src/').replace(/\.cjs$/, '.ts'),
    rel.replace(/\/dist\//, '/src/').replace(/\.js$/, '.ts'),
    rel.replace(/\/dist\//, '/src/').replace(/\.jsx$/, '.tsx'),
  ]
  for (const c of candidates) {
    if (allSet.has(c)) return c
  }
  return rel  // fallback : preserve l'original (dist) si pas de source equivalent
}

/** Résout un import local : ts-morph natif → alias `@/`/`~/` → relative.
 *
 * Cross-project leak guard : quand un monorepo a plusieurs sous-projets qui
 * réutilisent le même alias `@/*` (ex: backend `@/*` → `./src/*`, frontend
 * `@/*` → `./*`), un seul `tsconfigPath` ne peut pas représenter les deux.
 * ts-morph résout donc certains imports vers le mauvais sous-projet.
 *
 * On détecte ce cas (résolu vers un autre top-level dir que l'importeur) et
 * on retombe sur le resolver alias standalone qui restreint au sous-projet
 * de l'importeur. */
function resolveLocalImport(
  imp: import('ts-morph').ImportDeclaration,
  specifier: string,
  sourceFile: SourceFile,
  project: Project,
  rootDir: string,
  allFiles: string[],
  fromPath: string,
): string | null {
  const resolvedSf = imp.getModuleSpecifierSourceFile()
  if (resolvedSf) {
    const rel = relativizeAbs(resolvedSf.getFilePath(), rootDir)
    if (rel) {
      const isAlias = specifier.startsWith('@/') || specifier.startsWith('~/')
      if (isAlias && getSubProjectRoot(rel) !== getSubProjectRoot(fromPath)) {
        const aliased = resolveAliasStandalone(specifier, fromPath, allFiles)
        if (aliased) return aliased
      }
      return rel
    }
  }
  if (specifier.startsWith('@/') || specifier.startsWith('~/')) {
    return resolveAliasStandalone(specifier, fromPath, allFiles)
  }
  if (specifier.startsWith('.')) {
    return resolveRelativeStandalone(specifier, sourceFile.getFilePath(), rootDir, project)
  }
  return null
}

/** Sub-project root = top-level directory of a monorepo file path.
 *  `backend/src/lib/auth.ts` → `backend`
 *  `frontend/components/Layout.tsx` → `frontend`
 *  `packages/codegraph/src/foo.ts` → `packages` (good enough — disambiguation
 *  beyond top-level needs config). */
export function getSubProjectRoot(filePath: string): string {
  const i = filePath.indexOf('/')
  return i > 0 ? filePath.slice(0, i) : filePath
}

// ─── Dynamic imports : import('...') ────────────────────────────────────────

function scanDynamicImports(
  sourceFile: SourceFile,
  fromPath: string,
  project: Project,
  rootDir: string,
  links: DetectedLink[],
): void {
  for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (callExpr.getExpression().getText() !== 'import') continue
    const args = callExpr.getArguments()
    if (args.length === 0) continue
    const spec = args[0].getText().replace(/['"]/g, '')
    if (!spec.startsWith('.')) continue
    const resolved = resolveRelativeStandalone(spec, sourceFile.getFilePath(), rootDir, project)
    if (!resolved) continue
    links.push({
      from: fromPath, to: resolved, type: 'import',
      label: `dynamic: ${spec}`,
      resolved: !spec.includes('$'),
      line: callExpr.getStartLineNumber(),
      meta: { dynamic: true },
    })
  }
}

// ─── Re-exports : `export ... from '...'` ───────────────────────────────────

function scanReExports(
  sourceFile: SourceFile,
  fromPath: string,
  project: Project,
  rootDir: string,
  links: DetectedLink[],
): void {
  for (const exp of sourceFile.getExportDeclarations()) {
    const moduleSpecifier = exp.getModuleSpecifierValue()
    if (!moduleSpecifier) continue
    const toPath = resolveReExportPath(exp, moduleSpecifier, sourceFile, project, rootDir)
    if (!toPath || toPath.includes('node_modules')) continue
    links.push({
      from: fromPath, to: toPath, type: 'import',
      label: `re-export: ${moduleSpecifier}`,
      resolved: true,
      line: exp.getStartLineNumber(),
    })
  }
}

function resolveReExportPath(
  exp: import('ts-morph').ExportDeclaration,
  moduleSpecifier: string,
  sourceFile: SourceFile,
  project: Project,
  rootDir: string,
): string | null {
  const resolvedSource = exp.getModuleSpecifierSourceFile()
  if (resolvedSource) {
    const rel = relativizeAbs(resolvedSource.getFilePath(), rootDir)
    if (rel) return rel
  }
  if (moduleSpecifier.startsWith('.')) {
    return resolveRelativeStandalone(moduleSpecifier, sourceFile.getFilePath(), rootDir, project)
  }
  return null
}

function relativizeAbs(absPath: string, rootDir: string): string | null {
  const n = absPath.replace(/\\/g, '/')
  const r = rootDir.replace(/\\/g, '/')
  if (!n.startsWith(r)) return null
  return n.slice(r.length + 1)
}

function resolveRelativeStandalone(
  specifier: string,
  fromFilePath: string,
  rootDir: string,
  project: Project,
): string | null {
  const dir = path.dirname(fromFilePath)
  const stripped = specifier.replace(/\.(js|jsx|ts|tsx|mjs|cjs)$/, '')
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx']
  for (const ext of extensions) {
    const candidate = path.resolve(dir, stripped + ext)
    const rel = relativizeAbs(candidate, rootDir)
    if (rel && project.getSourceFile(candidate)) return rel
  }
  const direct = path.resolve(dir, specifier)
  const rel = relativizeAbs(direct, rootDir)
  if (rel && project.getSourceFile(direct)) return rel
  return null
}

/** Résout un alias `@/foo` ou `~/foo` en cherchant dans le sous-projet de
 *  l'importeur. Essaie deux conventions, du plus précis au plus permissif :
 *    1. `<sub-project>/src/<alias>` — convention TS classique (backend, packages)
 *    2. `<sub-project>/<alias>`     — convention Next.js flat (app/, components/)
 *
 *  Le filtrage par sous-projet évite la cross-pollution quand plusieurs
 *  sous-projets utilisent `@/*` avec des bases différentes. */
export function resolveAliasStandalone(
  specifier: string,
  fromFilePath: string,
  allFiles: string[],
): string | null {
  const aliasPath = specifier.replace(/^[@~]\//, '')
  const subProject = getSubProjectRoot(fromFilePath)
  if (!subProject) return null
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']
  const bases = [`${subProject}/src/${aliasPath}`, `${subProject}/${aliasPath}`]
  for (const base of bases) {
    for (const ext of extensions) {
      const candidate = base + ext
      if (allFiles.includes(candidate)) return candidate
    }
    if (allFiles.includes(base)) return base
  }
  return null
}
