// ADR-007
/**
 * Incremental tainted-vars — Salsa wrapper around the per-file AST scan
 * for tainted variable declarations + tainted argument calls.
 */

import { derived } from '@liby-tools/salsa'
import {
  extractTaintedVarsFileBundle,
  type TaintedVarsFileBundle,
  type TaintedVarDecl,
  type TaintedArgCall,
} from '../extractors/tainted-vars.js'
import { sharedDb as db } from './database.js'
import {
  fileContent,
  projectFiles,
  getIncrementalProject,
  getIncrementalRootDir,
} from './queries.js'
import * as path from 'node:path'

export const taintedVarsOfFile = derived<string, TaintedVarsFileBundle>(
  db,
  'taintedVarsOfFile',
  (filePath) => {
    fileContent.get(filePath)
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) return { decls: [], argCalls: [] }
    return extractTaintedVarsFileBundle(sf, filePath)
  },
)

export const allTaintedVars = derived<string, { decls: TaintedVarDecl[]; argCalls: TaintedArgCall[] }>(
  db,
  'allTaintedVars',
  (label) => {
    const files = projectFiles.get(label)
    const decls: TaintedVarDecl[] = []
    const argCalls: TaintedArgCall[] = []
    for (const f of files) {
      const bundle = taintedVarsOfFile.get(f)
      decls.push(...bundle.decls)
      argCalls.push(...bundle.argCalls)
    }
    const cmp = (a: { file: string; line: number }, b: { file: string; line: number }): number => {
      if (a.file !== b.file) return a.file < b.file ? -1 : 1
      return a.line - b.line
    }
    decls.sort(cmp)
    argCalls.sort(cmp)
    return { decls, argCalls }
  },
)
