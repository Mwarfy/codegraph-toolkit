import { type SourceFile, SyntaxKind } from 'ts-morph'
import type { BarrelFileFact, ImportEdgeFact } from './types.js'

function relativizePath(absPath: string, rootDir: string): string | null {
  if (!rootDir) return null
  const normalized = absPath.replace(/\\/g, '/')
  const root = rootDir.replace(/\\/g, '/')
  if (!normalized.startsWith(root)) return null
  return normalized.slice(root.length + 1)
}

export function visitBarrelsAndImports(
  sf: SourceFile,
  relPath: string,
  rootDir: string,
  barrelsOut: BarrelFileFact[],
  edgesOut: ImportEdgeFact[],
): void {
  for (const decl of sf.getImportDeclarations()) {
    const target = decl.getModuleSpecifierSourceFile()
    if (!target) continue
    const toFile = relativizePath(target.getFilePath() as string, rootDir)
    if (toFile) edgesOut.push({ fromFile: relPath, toFile })
  }
  for (const decl of sf.getExportDeclarations()) {
    const target = decl.getModuleSpecifierSourceFile()
    if (!target) continue
    const toFile = relativizePath(target.getFilePath() as string, rootDir)
    if (toFile) edgesOut.push({ fromFile: relPath, toFile })
  }

  const statements = sf.getStatements()
  if (statements.length === 0) return
  let reExports = 0
  for (const stmt of statements) {
    if (stmt.getKind() !== SyntaxKind.ExportDeclaration) return
    const mod = (stmt as unknown as { getModuleSpecifierValue?: () => string | undefined })
      .getModuleSpecifierValue?.()
    if (!mod) return
    reExports++
  }
  if (reExports === 0) return
  barrelsOut.push({ file: relPath, reExportCount: reExports })
}
