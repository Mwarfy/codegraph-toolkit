/**
 * Incremental symbol-refs — bundle per-file + agrégat trivial.
 *
 * Le coût dominant est l'AST scan + collectRefs par unit. Cache via
 * fileContent.
 */

import { derived } from '@liby/salsa'
import {
  extractSymbolRefsFileBundle,
  type SymbolRefsFileBundle,
  type SymbolRefsResult,
} from '../extractors/symbol-refs.js'
import { sharedDb as db } from './database.js'
import {
  fileContent,
  projectFiles,
  getIncrementalProject,
  getIncrementalRootDir,
} from './queries.js'
import * as path from 'node:path'

export const symbolRefsBundleOfFile = derived<string, SymbolRefsFileBundle>(
  db, 'symbolRefsBundleOfFile',
  (filePath) => {
    fileContent.get(filePath)
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) return { exportedSymbols: [], refs: [] }
    return extractSymbolRefsFileBundle(sf, filePath, rootDir)
  },
)

export const allSymbolRefs = derived<string, SymbolRefsResult>(
  db, 'allSymbolRefs',
  (label) => {
    const files = projectFiles.get(label)
    const refs: SymbolRefsResult['refs'] = []
    const exportedSymbols = new Set<string>()
    for (const f of files) {
      const bundle = symbolRefsBundleOfFile.get(f)
      for (const e of bundle.exportedSymbols) exportedSymbols.add(e)
      refs.push(...bundle.refs)
    }
    return { refs, exportedSymbols }
  },
)
