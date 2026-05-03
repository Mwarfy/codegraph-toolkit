// ADR-007
/**
 * Incremental arguments — Salsa wrapper around the per-file AST scan
 * for tainted argument-to-call edges + function param signatures.
 */

import { derived } from '@liby-tools/salsa'
import {
  extractArgumentsFileBundle,
  type ArgumentsFileBundle,
  type TaintedArgumentToCall,
  type FunctionParam,
} from '../extractors/arguments.js'
import { sharedDb as db } from './database.js'
import {
  fileContent,
  projectFiles,
  getIncrementalProject,
  getIncrementalRootDir,
} from './queries.js'
import * as path from 'node:path'

export const argumentsOfFile = derived<string, ArgumentsFileBundle>(
  db,
  'argumentsOfFile',
  (filePath) => {
    fileContent.get(filePath)
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) return { taintedArgs: [], params: [] }
    return extractArgumentsFileBundle(sf, filePath)
  },
)

export const allArguments = derived<string, { taintedArgs: TaintedArgumentToCall[]; params: FunctionParam[] }>(
  db,
  'allArguments',
  (label) => {
    const files = projectFiles.get(label)
    const taintedArgs: TaintedArgumentToCall[] = []
    const params: FunctionParam[] = []
    for (const f of files) {
      const bundle = argumentsOfFile.get(f)
      taintedArgs.push(...bundle.taintedArgs)
      params.push(...bundle.params)
    }
    return { taintedArgs, params }
  },
)
