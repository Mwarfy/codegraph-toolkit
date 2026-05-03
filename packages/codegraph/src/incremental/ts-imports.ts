// ADR-007
/**
 * Incremental ts-imports — bundle per-file (DetectedLink[]) + agrégat
 * trivial concat.
 *
 * Pourquoi ça compte : ts-imports était LE coupable warm (7.4s sur 7.9s
 * total après Sprint 5). Le détecteur legacy crée son PROPRE Project
 * ts-morph à chaque appel — un double-parse de tous les fichiers.
 *
 * Solution Salsa : `tsImportsOfFile(path)` réutilise le sharedProject
 * via `getIncrementalProject()`. Pas de second parse. Cache via
 * fileContent → modif d'1 fichier ne re-scan que ce fichier.
 */

import { derived } from '@liby-tools/salsa'
import { scanImportsInSourceFile } from '../detectors/ts-imports.js'
import type { DetectedLink } from '../core/types.js'
import { sharedDb as db } from './database.js'
import {
  fileContent,
  projectFiles,
  getIncrementalProject,
  getIncrementalRootDir,
} from './queries.js'
import * as path from 'node:path'

export const tsImportsOfFile = derived<string, DetectedLink[]>(
  db, 'tsImportsOfFile',
  (filePath) => {
    fileContent.get(filePath)
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) return []
    // Note : le helper a besoin de allFiles pour résoudre les alias @/.
    // On le récupère via projectFiles. C'est une dep Salsa supplémentaire,
    // mais projectFiles est rarement modifié → cache hit en pratique.
    const allFiles = projectFiles.get('all') as readonly string[]
    return scanImportsInSourceFile(sf, filePath, project, rootDir, allFiles as string[])
  },
)

export const allTsImports = derived<string, DetectedLink[]>(
  db, 'allTsImports',
  (label) => {
    const files = projectFiles.get(label)
    const out: DetectedLink[] = []
    for (const f of files) {
      out.push(...tsImportsOfFile.get(f))
    }
    return out
  },
)
