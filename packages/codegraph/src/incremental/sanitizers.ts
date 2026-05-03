// ADR-007
/**
 * Incremental sanitizers — Salsa wrapper around the per-file AST scan
 * for sanitizer call sites (zod parse, validateBody, escape*).
 */

import { derived } from '@liby-tools/salsa'
import {
  extractSanitizersFileBundle,
  type SanitizersFileBundle,
  type Sanitizer,
} from '../extractors/sanitizers.js'
import { sharedDb as db } from './database.js'
import {
  fileContent,
  projectFiles,
  getIncrementalProject,
  getIncrementalRootDir,
} from './queries.js'
import * as path from 'node:path'

export const sanitizersOfFile = derived<string, SanitizersFileBundle>(
  db,
  'sanitizersOfFile',
  (filePath) => {
    fileContent.get(filePath)
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) return { sanitizers: [] }
    return extractSanitizersFileBundle(sf, filePath)
  },
)

export const allSanitizers = derived<string, Sanitizer[]>(
  db,
  'allSanitizers',
  (label) => {
    const files = projectFiles.get(label)
    const out: Sanitizer[] = []
    for (const f of files) {
      out.push(...sanitizersOfFile.get(f).sanitizers)
    }
    out.sort((a, b) => {
      if (a.file !== b.file) return a.file < b.file ? -1 : 1
      return a.line - b.line
    })
    return out
  },
)
