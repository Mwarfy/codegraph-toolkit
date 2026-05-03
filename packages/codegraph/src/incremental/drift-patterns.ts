// ADR-007
/**
 * Incremental drift-patterns — Salsa wrapper around the per-file AST
 * scan for excessive-optional-params, wrapper-superfluous, deep-nesting,
 * empty-catch-no-comment patterns.
 *
 * Self-optim discovery : drift-patterns sortait dans les 3 hot warm
 * (mean=309ms, λ_lyap=1.00) — preuve mathématique de zéro cache.
 *
 * Particularité vs code-quality-patterns : l'agrégateur original
 * `analyzeDriftPatterns` mixe Patterns 1+2+4+5 (per-file AST) avec
 * Pattern 3 (todo-no-owner, dérivé de snapshot.todos). Salsa-iso ne
 * cache QUE l'AST part. Le call-site (analyzer.ts) merge avec les
 * signals todos-derived hors-Salsa puis re-sort. todos changent
 * indépendamment du fileContent, on évite ainsi une invalidation
 * croisée parasite.
 */

import { derived } from '@liby-tools/salsa'
import {
  extractDriftPatternsFileBundle,
  type DriftPatternsFileBundle,
  type DriftSignal,
} from '../extractors/drift-patterns.js'
import { sharedDb as db } from './database.js'
import {
  fileContent,
  projectFiles,
  getIncrementalProject,
  getIncrementalRootDir,
} from './queries.js'
import * as path from 'node:path'

const TEST_FILE_RE = /\.test\.tsx?$|\.spec\.tsx?$|(^|\/)tests?\//

/** Per-file bundle — cached on fileContent. */
export const driftPatternsOfFile = derived<string, DriftPatternsFileBundle>(
  db,
  'driftPatternsOfFile',
  (filePath) => {
    fileContent.get(filePath)                                              // dep tracking
    if (TEST_FILE_RE.test(filePath)) return { signals: [] }
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) return { signals: [] }
    return extractDriftPatternsFileBundle(sf, filePath)
  },
)

/**
 * Aggregator AST-only — combine les bundles per-file. **NE traite PAS
 * Pattern 3 (todo-no-owner)** — celui-ci est dérivé de snapshot.todos
 * et ajouté au call-site (analyzer.ts) après lecture du cache.
 */
export const allDriftPatternsAst = derived<string, DriftSignal[]>(
  db,
  'allDriftPatternsAst',
  (label) => {
    const files = projectFiles.get(label)
    const out: DriftSignal[] = []
    for (const f of files) {
      const bundle = driftPatternsOfFile.get(f)
      out.push(...bundle.signals)
    }
    // Tri stable : file → line → kind
    out.sort((a, b) => {
      if (a.file !== b.file) return a.file < b.file ? -1 : 1
      if (a.line !== b.line) return a.line - b.line
      return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0
    })
    return out
  },
)
