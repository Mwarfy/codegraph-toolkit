/**
 * TypeScript Import/Export Detector
 *
 * The foundational layer — discovers static import relationships
 * between all TypeScript files in the project.
 *
 * Uses ts-morph to resolve imports to actual file paths,
 * including tsconfig path aliases and index.ts barrel exports.
 */

import { Project, type SourceFile } from 'ts-morph'
import * as path from 'node:path'
import type { Detector, DetectorContext, DetectedLink } from '../core/types.js'

export class TsImportDetector implements Detector {
  name = 'ts-imports'
  edgeType = 'import' as const
  description = 'Static TypeScript import/export relationships'

  private project: Project | null = null

  async detect(ctx: DetectorContext): Promise<DetectedLink[]> {
    const links: DetectedLink[] = []

    // Find all tsconfig files to properly resolve path aliases
    const tsConfigCandidates = [
      path.join(ctx.rootDir, 'sentinel-web', 'tsconfig.json'),
      path.join(ctx.rootDir, 'sentinel-core', 'tsconfig.json'),
      path.join(ctx.rootDir, 'tsconfig.json'),
    ]

    let tsConfigPath: string | undefined
    for (const candidate of tsConfigCandidates) {
      try {
        await ctx.readFile(path.relative(ctx.rootDir, candidate))
        tsConfigPath = candidate
        break
      } catch {
        // Try next
      }
    }

    // Initialize ts-morph project — prefer loading from tsconfig for alias resolution
    this.project = new Project({
      tsConfigFilePath: tsConfigPath,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: {
        allowJs: true,
        resolveJsonModule: true,
      },
    })

    // Add all source files
    for (const relPath of ctx.files) {
      const absPath = path.join(ctx.rootDir, relPath)
      try {
        this.project.addSourceFileAtPath(absPath)
      } catch {
        // Skip files that can't be parsed
      }
    }

    // Analyze each file's imports
    for (const sourceFile of this.project.getSourceFiles()) {
      const fromPath = this.relativize(sourceFile.getFilePath(), ctx.rootDir)
      if (!fromPath) continue

      for (const imp of sourceFile.getImportDeclarations()) {
        const specifier = imp.getModuleSpecifierValue()

        // Skip bare specifiers (npm packages)
        if (!specifier.startsWith('.') && !specifier.startsWith('@/') && !specifier.startsWith('~/')) {
          // Could be a node_modules import — try ts-morph resolution
          const resolved = this.resolveImport(imp, ctx.rootDir)
          if (resolved && !resolved.includes('node_modules')) {
            links.push({
              from: fromPath,
              to: resolved,
              type: 'import',
              label: specifier,
              resolved: true,
              line: imp.getStartLineNumber(),
            })
          }
          continue
        }

        // Try ts-morph resolution first
        let toPath = this.resolveImport(imp, ctx.rootDir)

        // Fallback: resolve path aliases manually (e.g., @/ → src/)
        if (!toPath && (specifier.startsWith('@/') || specifier.startsWith('~/'))) {
          toPath = this.resolveAlias(specifier, fromPath, ctx.files)
        }

        // Fallback: relative path resolution
        if (!toPath && specifier.startsWith('.')) {
          toPath = this.resolveRelativePath(specifier, sourceFile.getFilePath(), ctx.rootDir)
        }

        if (!toPath) continue
        if (toPath.includes('node_modules')) continue

        links.push({
          from: fromPath,
          to: toPath,
          type: 'import',
          label: specifier,
          resolved: true,
          line: imp.getStartLineNumber(),
        })
      }

      // Also check dynamic imports: import('...')
      for (const callExpr of sourceFile.getDescendantsOfKind(
        (await import('ts-morph')).SyntaxKind.CallExpression
      )) {
        const expr = callExpr.getExpression()
        if (expr.getText() === 'import') {
          const args = callExpr.getArguments()
          if (args.length > 0) {
            const specifier = args[0].getText().replace(/['"]/g, '')
            if (specifier.startsWith('.')) {
              const resolved = this.resolveRelativePath(
                specifier,
                sourceFile.getFilePath(),
                ctx.rootDir
              )
              if (resolved) {
                links.push({
                  from: fromPath,
                  to: resolved,
                  type: 'import',
                  label: `dynamic: ${specifier}`,
                  resolved: !specifier.includes('$'),
                  line: callExpr.getStartLineNumber(),
                  meta: { dynamic: true },
                })
              }
            }
          }
        }
      }

      // Check re-exports: export { X } from './y'  |  export * from './y'
      //
      // BUG HISTORIQUE (fix 2026-04) : ce bloc appelait directement
      // resolveRelativePath(), qui tente une liste d'extensions en SUFFIXE
      // (`'./foo.js' + '.ts'` → `'./foo.js.ts'`). Avec la convention ESM+TS
      // (`import './foo.js'` alors que la source est `foo.ts`), la résolution
      // échouait silencieusement et TOUT un cluster (shared/catalog/*, les
      // barrel files, etc.) apparaissait comme déconnecté.
      //
      // Correctif : laisser ts-morph résoudre en premier (il gère les alias
      // de module et la règle .js↔.ts automatiquement), puis retomber sur
      // resolveRelativePath() qui lui-même fait maintenant le strip d'extension.
      for (const exp of sourceFile.getExportDeclarations()) {
        const moduleSpecifier = exp.getModuleSpecifierValue()
        if (!moduleSpecifier) continue

        let toPath: string | null = null

        // 1. ts-morph resolver (handles .js → .ts ESM convention natively)
        const resolvedSource = exp.getModuleSpecifierSourceFile()
        if (resolvedSource) {
          toPath = this.relativize(resolvedSource.getFilePath(), ctx.rootDir)
        }

        // 2. Fallback for relative specifiers ts-morph couldn't resolve
        if (!toPath && moduleSpecifier.startsWith('.')) {
          toPath = this.resolveRelativePath(
            moduleSpecifier,
            sourceFile.getFilePath(),
            ctx.rootDir
          )
        }

        if (!toPath) continue
        if (toPath.includes('node_modules')) continue

        links.push({
          from: fromPath,
          to: toPath,
          type: 'import',
          label: `re-export: ${moduleSpecifier}`,
          resolved: true,
          line: exp.getStartLineNumber(),
        })
      }
    }

    // Release le ts-morph Project avant de rendre la main — sinon il reste
    // en RAM toute la durée d'analyze() et cumule avec celui d'analyzeExports
    // (2+ GB au total sur ~200 fichiers, heap Node par défaut explose).
    this.project = null

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
    // e.g., sentinel-web/src/app/page.tsx → sentinel-web/src/
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
