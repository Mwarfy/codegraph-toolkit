// ADR-007
/**
 * Incremental taint-sinks — Salsa wrapper around the per-file AST scan
 * for taint sink call sites (eval, exec, query, fs writes...).
 *
 * Pattern Salsa identique a magic-numbers / hardcoded-secrets : per-file
 * bundle keye sur fileContent.
 */

import { derived } from '@liby-tools/salsa'
import {
  extractTaintSinksFileBundle,
  type TaintSinksFileBundle,
  type TaintSink,
} from '../extractors/taint-sinks.js'
import { sharedDb as db } from './database.js'
import {
  fileContent,
  projectFiles,
  getIncrementalProject,
  getIncrementalRootDir,
} from './queries.js'
import * as path from 'node:path'

export const taintSinksOfFile = derived<string, TaintSinksFileBundle>(
  db,
  'taintSinksOfFile',
  (filePath) => {
    fileContent.get(filePath)
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) return { sinks: [] }
    return extractTaintSinksFileBundle(sf, filePath)
  },
)

export const allTaintSinks = derived<string, TaintSink[]>(
  db,
  'allTaintSinks',
  (label) => {
    const files = projectFiles.get(label)
    const out: TaintSink[] = []
    for (const f of files) {
      out.push(...taintSinksOfFile.get(f).sinks)
    }
    out.sort((a, b) => {
      if (a.file !== b.file) return a.file < b.file ? -1 : 1
      return a.line - b.line
    })
    return out
  },
)
