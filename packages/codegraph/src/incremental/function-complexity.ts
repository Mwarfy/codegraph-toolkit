// ADR-007
/**
 * Incremental function-complexity — Salsa wrapper around the per-file
 * AST scan for cyclomatic + cognitive complexity per function.
 *
 * Self-optim discovery (run #3) : ce détecteur sortait hot warm
 * (mean=205ms, λ_lyap=1.00) — preuve mathématique de zéro cache.
 * Pattern Salsa identique à code-quality-patterns / hardcoded-secrets.
 *
 * Spécificité : l'extractor retourne un array plat (pas un bundle) — on
 * wrap quand même via une cell qui stocke `FunctionComplexity[]` per-file.
 */

import { derived } from '@liby-tools/salsa'
import {
  extractFunctionComplexityFileBundle,
  type FunctionComplexity,
} from '../extractors/function-complexity.js'
import { sharedDb as db } from './database.js'
import {
  fileContent,
  projectFiles,
  getIncrementalProject,
  getIncrementalRootDir,
} from './queries.js'
import * as path from 'node:path'

/** Per-file array — cached on fileContent. */
export const functionComplexityOfFile = derived<string, FunctionComplexity[]>(
  db,
  'functionComplexityOfFile',
  (filePath) => {
    fileContent.get(filePath)                                              // dep tracking
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) return []
    return extractFunctionComplexityFileBundle(sf, filePath)
  },
)

/** Global aggregator — concat tous les per-file arrays + tri stable. */
export const allFunctionComplexity = derived<string, FunctionComplexity[]>(
  db,
  'allFunctionComplexity',
  (label) => {
    const files = projectFiles.get(label)
    const out: FunctionComplexity[] = []
    for (const f of files) {
      out.push(...functionComplexityOfFile.get(f))
    }
    out.sort((a, b) =>
      a.file !== b.file ? (a.file < b.file ? -1 : 1) :
      a.line - b.line,
    )
    return out
  },
)
