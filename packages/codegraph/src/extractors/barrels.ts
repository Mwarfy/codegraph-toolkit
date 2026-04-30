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

  // ─── 1. Détection barrels (per-file scan) ─────────────────────────
  const barrels = new Map<string, { reExportCount: number; abs: string }>()
  for (const sf of project.getSourceFiles()) {
    const absPath = sf.getFilePath() as string
    const relPath = path.relative(rootDir, absPath).replace(/\\/g, '/')
    if (!fileSet.has(relPath)) continue
    const info = scanBarrelInSourceFile(sf)
    if (info) barrels.set(relPath, { ...info, abs: absPath })
  }

  if (barrels.size === 0) return []

  // ─── 2. Comptage consumers ───────────────────────────────────────
  const consumers = new Map<string, Set<string>>()
  for (const rel of barrels.keys()) consumers.set(rel, new Set())

  for (const sf of project.getSourceFiles()) {
    const absPath = sf.getFilePath() as string
    const relPath = path.relative(rootDir, absPath).replace(/\\/g, '/')
    if (!fileSet.has(relPath)) continue
    for (const tRel of collectImportTargetsRel(sf, rootDir)) {
      if (tRel === relPath) continue
      if (barrels.has(tRel)) consumers.get(tRel)!.add(relPath)
    }
  }

  return buildBarrelInfos(barrels, consumers, threshold)
}

/**
 * Détermine si un SourceFile est un barrel et compte ses re-exports.
 * Retourne null si le fichier n'est PAS un barrel.
 */
export function scanBarrelInSourceFile(
  sf: SourceFile,
): { reExportCount: number } | null {
  const statements = sf.getStatements()
  if (statements.length === 0) return null
  let reExports = 0
  for (const stmt of statements) {
    if (stmt.getKind() !== SyntaxKind.ExportDeclaration) return null
    const mod = (stmt as any).getModuleSpecifierValue?.()
    if (!mod) return null
    reExports++
  }
  if (reExports === 0) return null
  return { reExportCount: reExports }
}

/**
 * Liste des targets d'imports/exports d'un SourceFile, en chemins
 * relatifs au rootDir. Résolution déléguée à ts-morph (gère
 * `./foo/index.ts`, etc.). Les imports sans target résolvable sont
 * ignorés silencieusement.
 */
export function collectImportTargetsRel(
  sf: SourceFile,
  rootDir: string,
): string[] {
  const out: string[] = []
  for (const decl of sf.getImportDeclarations()) {
    const target = decl.getModuleSpecifierSourceFile()
    if (target) {
      out.push(path.relative(rootDir, target.getFilePath() as string).replace(/\\/g, '/'))
    }
  }
  for (const decl of sf.getExportDeclarations()) {
    const target = decl.getModuleSpecifierSourceFile()
    if (target) {
      out.push(path.relative(rootDir, target.getFilePath() as string).replace(/\\/g, '/'))
    }
  }
  return out
}

/**
 * Pure : construit les BarrelInfo à partir des barrels détectés et de
 * leurs consumers. Réutilisable côté Salsa.
 */
export function buildBarrelInfos(
  barrels: Map<string, { reExportCount: number }>,
  consumers: Map<string, Set<string>>,
  threshold: number,
): BarrelInfo[] {
  const out: BarrelInfo[] = []
  for (const [rel, info] of barrels) {
    const cs = [...(consumers.get(rel) ?? [])].sort()
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

export const DEFAULT_BARREL_THRESHOLD = 2
