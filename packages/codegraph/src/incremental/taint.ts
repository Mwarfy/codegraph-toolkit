/**
 * Incremental taint — pure per-file (taint analysis est intra-scope,
 * pas cross-file). Cache via fileContent. Les rules sont passées en
 * input Salsa (set par analyze() après lecture du JSON config).
 */

import { derived, input } from '@liby/salsa'
import { scanTaintInSourceFile } from '../extractors/taint.js'
import type { TaintViolation, TaintRules } from '../core/types.js'
import { sharedDb as db } from './database.js'
import {
  fileContent,
  projectFiles,
  getIncrementalProject,
  getIncrementalRootDir,
} from './queries.js'
import * as path from 'node:path'

/** Rules taint chargées depuis config (taint-rules.json). Set par analyze(). */
export const taintRulesInput = input<string, TaintRules>(db, 'taintRules')

export const taintOfFile = derived<string, TaintViolation[]>(
  db, 'taintOfFile',
  (filePath) => {
    fileContent.get(filePath)
    if (!taintRulesInput.has('all')) return []
    const rules = taintRulesInput.get('all')
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) return []
    return scanTaintInSourceFile(sf, filePath, rules)
  },
)

export const allTaintViolations = derived<string, TaintViolation[]>(
  db, 'allTaintViolations',
  (label) => {
    const files = projectFiles.get(label)
    const out: TaintViolation[] = []
    for (const f of files) {
      out.push(...taintOfFile.get(f))
    }
    out.sort((a, b) => {
      if (a.file !== b.file) return a.file < b.file ? -1 : 1
      return a.line - b.line
    })
    return out
  },
)
