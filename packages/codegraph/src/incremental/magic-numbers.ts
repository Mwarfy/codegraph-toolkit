// ADR-007
/**
 * Incremental magic-numbers — Salsa wrapper around the per-file AST
 * scan for magic number literals (timeouts, thresholds, ratios).
 *
 * Self-optim discovery : ce detecteur sort hot warm dans le ranking
 * (mean=539ms warm, sans cache). Pattern Salsa identique a
 * hardcoded-secrets / constant-expressions / security-patterns
 * (per-file bundle keye sur fileContent).
 */

import { derived } from '@liby-tools/salsa'
import {
  extractMagicNumbersFileBundle,
  type MagicNumbersFileBundle,
  type MagicNumber,
} from '../extractors/magic-numbers.js'
import { sharedDb as db } from './database.js'
import {
  fileContent,
  projectFiles,
  getIncrementalProject,
  getIncrementalRootDir,
} from './queries.js'
import * as path from 'node:path'

const TEST_FILE_RE = /(\.test\.tsx?|\.spec\.tsx?|(^|\/)tests?\/|(^|\/)__tests__\/)/

/** Per-file bundle — cached on fileContent. */
export const magicNumbersOfFile = derived<string, MagicNumbersFileBundle>(
  db,
  'magicNumbersOfFile',
  (filePath) => {
    fileContent.get(filePath)  // dep tracking
    if (TEST_FILE_RE.test(filePath)) return { numbers: [] }
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) return { numbers: [] }
    return extractMagicNumbersFileBundle(sf, filePath, 1000)
  },
)

/** Global aggregator — combine tous les per-file bundles + tri stable. */
export const allMagicNumbers = derived<string, MagicNumber[]>(
  db,
  'allMagicNumbers',
  (label) => {
    const files = projectFiles.get(label)
    const out: MagicNumber[] = []
    for (const f of files) {
      const bundle = magicNumbersOfFile.get(f)
      out.push(...bundle.numbers)
    }
    out.sort((a, b) => {
      if (a.file !== b.file) return a.file < b.file ? -1 : 1
      return a.line - b.line
    })
    return out
  },
)
