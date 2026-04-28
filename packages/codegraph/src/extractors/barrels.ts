/**
 * Barrels Extractor — structural map phase 3.8 #7
 *
 * Un fichier barrel = 100 % des statements top-level sont des ré-exports
 * (`export * from '...'` ou `export { ... } from '...'`). Les déclarations
 * (fonctions, classes, types, const) disqualifient le fichier — c'est un
 * vrai module, pas un pass-through.
 *
 * Pour chaque barrel détecté, on compte ses consumers directs (fichiers qui
 * l'importent via résolution ts-morph — gère `./foo/index.ts` automatiquement).
 * `lowValue` true quand `consumers < threshold` (default 2) : barrel qui
 * n'agrège rien — la ré-export sans valeur ajoutée.
 */

import { Project, SyntaxKind, type SourceFile } from 'ts-morph'
import * as path from 'node:path'
import type { BarrelInfo } from '../core/types.js'

export interface BarrelsOptions {
  /** Seuil minimal de consumers pour ne PAS être `lowValue`. Default 2. */
  minConsumers?: number
}

export async function analyzeBarrels(
  rootDir: string,
  files: string[],
  project: Project,
  options: BarrelsOptions = {},
): Promise<BarrelInfo[]> {
  const threshold = options.minConsumers ?? 2
  const fileSet = new Set(files)

  // ─── 1. Détection barrels ─────────────────────────────────────────
  const barrels = new Map<string, { reExportCount: number; abs: string }>()

  for (const sf of project.getSourceFiles()) {
    const absPath = sf.getFilePath() as string
    const relPath = path.relative(rootDir, absPath).replace(/\\/g, '/')
    if (!fileSet.has(relPath)) continue

    const statements = sf.getStatements()
    if (statements.length === 0) continue

    let reExports = 0
    let isBarrel = true
    for (const stmt of statements) {
      if (stmt.getKind() !== SyntaxKind.ExportDeclaration) {
        isBarrel = false
        break
      }
      const mod = (stmt as any).getModuleSpecifierValue?.()
      if (!mod) { isBarrel = false; break }
      reExports++
    }

    if (isBarrel && reExports > 0) {
      barrels.set(relPath, { reExportCount: reExports, abs: absPath })
    }
  }

  if (barrels.size === 0) return []

  // ─── 2. Comptage consumers ───────────────────────────────────────
  const consumers = new Map<string, Set<string>>()
  for (const rel of barrels.keys()) consumers.set(rel, new Set())

  for (const sf of project.getSourceFiles()) {
    const absPath = sf.getFilePath() as string
    const relPath = path.relative(rootDir, absPath).replace(/\\/g, '/')
    if (!fileSet.has(relPath)) continue

    for (const target of collectImportTargets(sf)) {
      const tAbs = target.getFilePath() as string
      const tRel = path.relative(rootDir, tAbs).replace(/\\/g, '/')
      if (tRel === relPath) continue  // auto-import aberrant — ignore
      if (barrels.has(tRel)) {
        consumers.get(tRel)!.add(relPath)
      }
    }
  }

  // ─── 3. Build output ─────────────────────────────────────────────
  const out: BarrelInfo[] = []
  for (const [rel, info] of barrels) {
    const cs = [...consumers.get(rel)!].sort()
    out.push({
      file: rel,
      reExportCount: info.reExportCount,
      consumers: cs,
      consumerCount: cs.length,
      lowValue: cs.length < threshold,
    })
  }

  out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  return out
}

function collectImportTargets(sf: SourceFile): SourceFile[] {
  const out: SourceFile[] = []
  for (const decl of sf.getImportDeclarations()) {
    const target = decl.getModuleSpecifierSourceFile()
    if (target) out.push(target)
  }
  for (const decl of sf.getExportDeclarations()) {
    const target = decl.getModuleSpecifierSourceFile()
    if (target) out.push(target)
  }
  return out
}
