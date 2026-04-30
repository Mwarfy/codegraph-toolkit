/**
 * Incremental barrels — wrap Salsa autour de la détection per-file +
 * comptage consumers cross-file.
 *
 * Architecture :
 *   - `barrelInfoOfFile(path)` : derived → { reExportCount } | null
 *   - `importTargetsOfFile(path)` : derived → string[] (targets relatifs)
 *   - `allBarrels(label)` : agrégat global qui croise les deux.
 *
 * Modif d'1 fichier : seul ce fichier réparse pour barrelInfo +
 * importTargets. L'agrégat re-tourne (il itère sur tous), mais lit
 * tous les sub-queries depuis le cache.
 *
 * Note : la résolution `getModuleSpecifierSourceFile()` peut renvoyer
 * différents chemins si la structure du Project change (ajout d'un
 * index.ts entre deux fichiers). On suppose un Project cohérent à
 * chaque analyze() — invalidation cross-file via une autre dep n'est
 * pas modélisée v1.
 */

import { derived } from '@liby-tools/salsa'
import {
  scanBarrelInSourceFile,
  collectImportTargetsRel,
  buildBarrelInfos,
  DEFAULT_BARREL_THRESHOLD,
} from '../extractors/barrels.js'
import type { BarrelInfo } from '../core/types.js'
import { sharedDb as db } from './database.js'
import {
  fileContent,
  projectFiles,
  getIncrementalProject,
  getIncrementalRootDir,
} from './queries.js'
import * as path from 'node:path'

export const barrelInfoOfFile = derived<string, { reExportCount: number } | null>(
  db, 'barrelInfoOfFile',
  (filePath) => {
    fileContent.get(filePath)
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) return null
    return scanBarrelInSourceFile(sf)
  },
)

export const importTargetsOfFile = derived<string, readonly string[]>(
  db, 'importTargetsOfFile',
  (filePath) => {
    fileContent.get(filePath)
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) return []
    return collectImportTargetsRel(sf, rootDir)
  },
)

export const allBarrels = derived<string, BarrelInfo[]>(
  db, 'allBarrels',
  (label) => {
    const files = projectFiles.get(label)

    const barrels = new Map<string, { reExportCount: number }>()
    for (const f of files) {
      const info = barrelInfoOfFile.get(f)
      if (info) barrels.set(f, info)
    }
    if (barrels.size === 0) return []

    const consumers = new Map<string, Set<string>>()
    for (const rel of barrels.keys()) consumers.set(rel, new Set())

    for (const f of files) {
      for (const tRel of importTargetsOfFile.get(f)) {
        if (tRel === f) continue
        if (barrels.has(tRel)) consumers.get(tRel)!.add(f)
      }
    }

    return buildBarrelInfos(barrels, consumers, DEFAULT_BARREL_THRESHOLD)
  },
)
