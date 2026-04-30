/**
 * Incremental complexity — pure per-file (aucune dépendance cross-file).
 *
 * Le helper `analyzeComplexityInSourceFile(sf)` du legacy fait déjà
 * tout le travail. On le wrap dans une derived query qui invalide via
 * fileContent.
 */

import { derived } from '@liby/salsa'
import { analyzeComplexityInSourceFile } from '../detectors/complexity.js'
import type { FileComplexityInfo } from '../detectors/complexity.js'
import { sharedDb as db } from './database.js'
import {
  fileContent,
  projectFiles,
  getIncrementalProject,
  getIncrementalRootDir,
} from './queries.js'
import * as path from 'node:path'

export const complexityOfFile = derived<string, FileComplexityInfo | null>(
  db, 'complexityOfFile',
  (filePath) => {
    fileContent.get(filePath)
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) return null
    try {
      const info = analyzeComplexityInSourceFile(sf)
      if (info) info.file = filePath
      return info
    } catch {
      return null
    }
  },
)

export const allComplexity = derived<string, FileComplexityInfo[]>(
  db, 'allComplexity',
  (label) => {
    const files = projectFiles.get(label)
    const out: FileComplexityInfo[] = []
    for (const f of files) {
      const info = complexityOfFile.get(f)
      if (info) out.push(info)
    }
    // Pas de tri : le legacy n'en fait pas (ordre de project.getSourceFiles()).
    // Pour la parité on doit garder le même ordre — on tri par file pour
    // le déterminisme.
    out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    return out
  },
)
