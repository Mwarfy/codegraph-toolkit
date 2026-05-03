// ADR-007
/**
 * Incremental security-patterns — Salsa wrapper for the per-file scan
 * (secret refs, CORS configs, TLS unsafe, weak random).
 *
 * Self-optim discovery : λ_lyap = 1.03 + p95 = 766ms = candidat optim.
 * Pure per-file (pas d'état global), Salsa-isation directe.
 */

import { derived } from '@liby-tools/salsa'
import {
  extractSecurityPatternsFileBundle,
  type SecurityPatternsFileBundle,
  type SecurityPatternsAggregated,
} from '../extractors/security-patterns.js'
import { sharedDb as db } from './database.js'
import {
  fileContent,
  projectFiles,
  getIncrementalProject,
  getIncrementalRootDir,
} from './queries.js'
import * as path from 'node:path'

export const securityPatternsOfFile = derived<string, SecurityPatternsFileBundle>(
  db,
  'securityPatternsOfFile',
  (filePath) => {
    fileContent.get(filePath)
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) {
      return { secretRefs: [], corsConfigs: [], tlsUnsafe: [], weakRandoms: [] }
    }
    return extractSecurityPatternsFileBundle(sf, filePath)
  },
)

export const allSecurityPatterns = derived<string, SecurityPatternsAggregated>(
  db,
  'allSecurityPatterns',
  (label) => {
    const files = projectFiles.get(label)
    const out: SecurityPatternsAggregated = {
      secretRefs: [],
      corsConfigs: [],
      tlsUnsafe: [],
      weakRandoms: [],
    }
    for (const f of files) {
      const bundle = securityPatternsOfFile.get(f)
      out.secretRefs.push(...bundle.secretRefs)
      out.corsConfigs.push(...bundle.corsConfigs)
      out.tlsUnsafe.push(...bundle.tlsUnsafe)
      out.weakRandoms.push(...bundle.weakRandoms)
    }
    const sortFn = (
      a: { file: string; line: number },
      b: { file: string; line: number },
    ) => (a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.line - b.line)
    out.secretRefs.sort(sortFn)
    out.corsConfigs.sort(sortFn)
    out.tlsUnsafe.sort(sortFn)
    out.weakRandoms.sort(sortFn)
    return out
  },
)
