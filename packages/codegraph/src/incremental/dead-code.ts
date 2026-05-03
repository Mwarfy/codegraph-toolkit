// ADR-007
/**
 * Incremental dead-code — Salsa wrapper for the per-file `A === A` /
 * `A && A` / unreachable-code scan.
 *
 * Self-optim discovery : λ_lyap = 1.01 + p95 = 408ms = candidat optim.
 * Pure per-file (pas d'état global), Salsa-isation triviale.
 */

import { derived } from '@liby-tools/salsa'
import {
  extractDeadCodeFileBundle,
  type DeadCodeFinding,
  type DeadCodeFileBundle,
} from '../extractors/dead-code.js'
import { sharedDb as db } from './database.js'
import {
  fileContent,
  projectFiles,
  getIncrementalProject,
  getIncrementalRootDir,
} from './queries.js'
import * as path from 'node:path'

export const deadCodeOfFile = derived<string, DeadCodeFileBundle>(
  db,
  'deadCodeOfFile',
  (filePath) => {
    fileContent.get(filePath)
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) return { findings: [] }
    return extractDeadCodeFileBundle(sf, filePath)
  },
)

export const allDeadCode = derived<string, DeadCodeFinding[]>(
  db,
  'allDeadCode',
  (label) => {
    const files = projectFiles.get(label)
    const findings: DeadCodeFinding[] = []
    for (const f of files) {
      findings.push(...deadCodeOfFile.get(f).findings)
    }
    findings.sort((a, b) =>
      a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.line - b.line,
    )
    return findings
  },
)
