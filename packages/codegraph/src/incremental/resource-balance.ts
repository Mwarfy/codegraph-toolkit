// ADR-007
/**
 * Incremental resource-balance — Salsa wrapper around the per-file AST
 * scan for acquire/release imbalance patterns (lock/unlock, connect/
 * disconnect, etc.).
 *
 * Pattern Salsa identique a magic-numbers / hardcoded-secrets : per-file
 * bundle keye sur fileContent.
 */

import { derived } from '@liby-tools/salsa'
import {
  extractResourceBalanceFileBundle,
  type ResourceBalanceFileBundle,
  type ResourceImbalance,
} from '../extractors/resource-balance.js'
import { sharedDb as db } from './database.js'
import {
  fileContent,
  projectFiles,
  getIncrementalProject,
  getIncrementalRootDir,
} from './queries.js'
import * as path from 'node:path'

/** Per-file bundle — cached on fileContent. */
export const resourceBalanceOfFile = derived<string, ResourceBalanceFileBundle>(
  db,
  'resourceBalanceOfFile',
  (filePath) => {
    fileContent.get(filePath)  // dep tracking
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) return { imbalances: [] }
    return extractResourceBalanceFileBundle(sf, filePath)
  },
)

/** Global aggregator — combine tous les per-file bundles + tri stable. */
export const allResourceBalances = derived<string, ResourceImbalance[]>(
  db,
  'allResourceBalances',
  (label) => {
    const files = projectFiles.get(label)
    const out: ResourceImbalance[] = []
    for (const f of files) {
      const bundle = resourceBalanceOfFile.get(f)
      out.push(...bundle.imbalances)
    }
    out.sort((a, b) => {
      if (a.file !== b.file) return a.file < b.file ? -1 : 1
      return a.line - b.line
    })
    return out
  },
)
