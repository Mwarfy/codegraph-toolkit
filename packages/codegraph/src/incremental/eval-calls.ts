// ADR-007
/**
 * Incremental eval-calls — Salsa wrapper around the per-file AST scan
 * for `eval(...)` + `new Function(...)` call-sites.
 *
 * Self-optim discovery (run #4) : ce détecteur sort hot warm
 * (mean=221ms, λ_lyap=1.00) après les autres Salsa-isolations qui
 * libèrent du temps wall-clock — l'absence de cache devient visible.
 * Pattern Salsa identique à code-quality-patterns.
 */

import { derived } from '@liby-tools/salsa'
import {
  extractEvalCallsFileBundle,
  type EvalCallsFileBundle,
  type EvalCall,
} from '../extractors/eval-calls.js'
import { sharedDb as db } from './database.js'
import {
  fileContent,
  projectFiles,
  getIncrementalProject,
  getIncrementalRootDir,
} from './queries.js'
import * as path from 'node:path'

/** Per-file bundle — cached on fileContent. */
export const evalCallsOfFile = derived<string, EvalCallsFileBundle>(
  db,
  'evalCallsOfFile',
  (filePath) => {
    fileContent.get(filePath)                                              // dep tracking
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) return { calls: [] }
    return extractEvalCallsFileBundle(sf, filePath)
  },
)

/** Global aggregator — combine tous les per-file bundles + tri stable. */
export const allEvalCalls = derived<string, EvalCall[]>(
  db,
  'allEvalCalls',
  (label) => {
    const files = projectFiles.get(label)
    const out: EvalCall[] = []
    for (const f of files) {
      const bundle = evalCallsOfFile.get(f)
      out.push(...bundle.calls)
    }
    out.sort((a, b) =>
      a.file !== b.file ? (a.file < b.file ? -1 : 1) :
      a.line - b.line,
    )
    return out
  },
)
