// ADR-007
/**
 * Incremental constant-expressions — Salsa wrapper around the per-file
 * AST scan for tautology / contradiction / gratuitous-bool patterns.
 *
 * Self-optim discovery : ce détecteur sortait dans les 3 hot warm
 * (mean=349ms, λ_lyap=1.00) — preuve mathématique qu'il ne profitait
 * d'AUCUN cache. Pattern Salsa identique à code-quality-patterns.ts.
 *
 *   - `constantExprOfFile(path)` : derived → Bundle pour 1 fichier.
 *     Dep tracking sur `fileContent(path)` → invalidation file-scoped.
 *   - `allConstantExpressions(label)` : agrège tous les bundles + tri
 *     global déterministe.
 */

import { derived } from '@liby-tools/salsa'
import {
  extractConstantExpressionsFileBundle,
  type ConstantExpressionsFileBundle,
  type ConstantExpressionFinding,
} from '../extractors/constant-expressions.js'
import { sharedDb as db } from './database.js'
import {
  fileContent,
  projectFiles,
  getIncrementalProject,
  getIncrementalRootDir,
} from './queries.js'
import * as path from 'node:path'

/** Per-file bundle — cached on fileContent. */
export const constantExprOfFile = derived<string, ConstantExpressionsFileBundle>(
  db,
  'constantExprOfFile',
  (filePath) => {
    fileContent.get(filePath)                                              // dep tracking
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) return { findings: [] }
    return extractConstantExpressionsFileBundle(sf, filePath)
  },
)

/** Global aggregator — combine tous les per-file bundles + tri stable. */
export const allConstantExpressions = derived<string, ConstantExpressionFinding[]>(
  db,
  'allConstantExpressions',
  (label) => {
    const files = projectFiles.get(label)
    const out: ConstantExpressionFinding[] = []
    for (const f of files) {
      const bundle = constantExprOfFile.get(f)
      out.push(...bundle.findings)
    }
    out.sort((a, b) =>
      a.file !== b.file ? (a.file < b.file ? -1 : 1) :
      a.line !== b.line ? a.line - b.line :
      a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0,
    )
    return out
  },
)
