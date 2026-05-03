// ADR-007
/**
 * Incremental boolean-params — Salsa wrapper around the per-file AST
 * scan for boolean positional params (Clean Code anti-pattern).
 */

import { derived } from '@liby-tools/salsa'
import {
  extractBooleanParamsFileBundle,
  type BooleanParamsFileBundle,
  type BooleanParamSite,
} from '../extractors/boolean-params.js'
import { sharedDb as db } from './database.js'
import {
  fileContent,
  projectFiles,
  getIncrementalProject,
  getIncrementalRootDir,
} from './queries.js'
import * as path from 'node:path'

export const booleanParamsOfFile = derived<string, BooleanParamsFileBundle>(
  db,
  'booleanParamsOfFile',
  (filePath) => {
    fileContent.get(filePath)
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) return { sites: [] }
    return extractBooleanParamsFileBundle(sf, filePath)
  },
)

export const allBooleanParams = derived<string, BooleanParamSite[]>(
  db,
  'allBooleanParams',
  (label) => {
    const files = projectFiles.get(label)
    const out: BooleanParamSite[] = []
    for (const f of files) {
      out.push(...booleanParamsOfFile.get(f).sites)
    }
    out.sort((a, b) => {
      if (a.file !== b.file) return a.file < b.file ? -1 : 1
      return a.line - b.line
    })
    return out
  },
)
