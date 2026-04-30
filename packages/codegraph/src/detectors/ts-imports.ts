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

    for (const sourceFile of this.project.getSourceFiles()) {
      const fromPath = this.relativize(sourceFile.getFilePath(), ctx.rootDir)
      if (!fromPath) continue
      links.push(...scanImportsInSourceFile(sourceFile, fromPath, this.project, ctx.rootDir, ctx.files))
    }

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

  for (const imp of sourceFile.getImportDeclarations()) {
    const specifier = imp.getModuleSpecifierValue()
    if (!specifier.startsWith('.') && !specifier.startsWith('@/') && !specifier.startsWith('~/')) {
      const resolved = imp.getModuleSpecifierSourceFile()
      if (resolved) {
        const rel = relativizeAbs(resolved.getFilePath(), rootDir)
        if (rel && !rel.includes('node_modules')) {
          links.push({
            from: fromPath, to: rel, type: 'import',
            label: specifier, resolved: true,
            line: imp.getStartLineNumber(),
          })
        }
      }
      continue
    }

    let toPath: string | null = null
    const resolvedSf = imp.getModuleSpecifierSourceFile()
    if (resolvedSf) toPath = relativizeAbs(resolvedSf.getFilePath(), rootDir)

    if (!toPath && (specifier.startsWith('@/') || specifier.startsWith('~/'))) {
      toPath = resolveAliasStandalone(specifier, fromPath, allFiles)
    }
    if (!toPath && specifier.startsWith('.')) {
      toPath = resolveRelativeStandalone(specifier, sourceFile.getFilePath(), rootDir, project)
    }
    if (!toPath || toPath.includes('node_modules')) continue

    links.push({
      from: fromPath, to: toPath, type: 'import',
      label: specifier, resolved: true,
      line: imp.getStartLineNumber(),
    })
  }

  // Dynamic imports : import('...')
  for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = callExpr.getExpression()
    if (expr.getText() !== 'import') continue
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

  // Re-exports : `export ... from '...'`
  for (const exp of sourceFile.getExportDeclarations()) {
    const moduleSpecifier = exp.getModuleSpecifierValue()
    if (!moduleSpecifier) continue
    let toPath: string | null = null
    const resolvedSource = exp.getModuleSpecifierSourceFile()
    if (resolvedSource) toPath = relativizeAbs(resolvedSource.getFilePath(), rootDir)
    if (!toPath && moduleSpecifier.startsWith('.')) {
      toPath = resolveRelativeStandalone(moduleSpecifier, sourceFile.getFilePath(), rootDir, project)
    }
    if (!toPath || toPath.includes('node_modules')) continue
    links.push({
      from: fromPath, to: toPath, type: 'import',
      label: `re-export: ${moduleSpecifier}`,
      resolved: true,
      line: exp.getStartLineNumber(),
    })
  }

  return links
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

function resolveAliasStandalone(
  specifier: string,
  fromFilePath: string,
  allFiles: string[],
): string | null {
  const aliasPath = specifier.replace(/^[@~]\//, '')
  const parts = fromFilePath.split('/')
  const srcIndex = parts.indexOf('src')
  if (srcIndex < 0) return null
  const projectPrefix = parts.slice(0, srcIndex + 1).join('/')
  const candidateBase = `${projectPrefix}/${aliasPath}`
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']
  for (const ext of extensions) {
    const candidate = candidateBase + ext
    if (allFiles.includes(candidate)) return candidate
  }
  if (allFiles.includes(candidateBase)) return candidateBase
  return null
}
