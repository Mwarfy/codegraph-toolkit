// ADR-007
/**
 * Incremental code-quality-patterns — Salsa wrapper around the per-file
 * AST scan for regex literals, try-catch swallows, await-in-loop, and
 * allocation-in-loop patterns.
 *
 * Self-optim discovery : ce détecteur est sorti #6 par p95 (572ms warm)
 * avec λ_lyap = 1.01 — preuve mathématique qu'il ne profite d'AUCUN
 * cache. Salsa-isation attendue : ~99% cache hit warm, gain ~550ms/run.
 *
 * Architecture (pattern ADR-005 + ADR-007) :
 *   - `codeQualityOfFile(path)` : derived → Bundle pour 1 fichier.
 *     Dep tracking sur `fileContent(path)` → invalidation file-scoped.
 *   - `allCodeQualityPatterns(label)` : agrège tous les bundles +
 *     applique le tri global déterministe.
 */

import { derived } from '@liby-tools/salsa'
import {
  extractCodeQualityPatternsFileBundle,
  type CodeQualityPatternsBundle,
  type CodeQualityPatternsAggregated,
} from '../extractors/code-quality-patterns.js'
import { sharedDb as db } from './database.js'
import {
  fileContent,
  projectFiles,
  getIncrementalProject,
  getIncrementalRootDir,
} from './queries.js'
import * as path from 'node:path'

/** Per-file bundle — cached on fileContent. */
export const codeQualityOfFile = derived<string, CodeQualityPatternsBundle>(
  db,
  'codeQualityOfFile',
  (filePath) => {
    fileContent.get(filePath)                                              // dep tracking
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) {
      return {
        regexLiterals: [],
        tryCatchSwallows: [],
        awaitInLoops: [],
        allocationInLoops: [],
      }
    }
    return extractCodeQualityPatternsFileBundle(sf, filePath)
  },
)

/** Global aggregator — combine tous les per-file bundles. */
export const allCodeQualityPatterns = derived<string, CodeQualityPatternsAggregated>(
  db,
  'allCodeQualityPatterns',
  (label) => {
    const files = projectFiles.get(label)
    const out: CodeQualityPatternsAggregated = {
      regexLiterals: [],
      tryCatchSwallows: [],
      awaitInLoops: [],
      allocationInLoops: [],
    }
    for (const f of files) {
      const bundle = codeQualityOfFile.get(f)
      out.regexLiterals.push(...bundle.regexLiterals)
      out.tryCatchSwallows.push(...bundle.tryCatchSwallows)
      out.awaitInLoops.push(...bundle.awaitInLoops)
      out.allocationInLoops.push(...bundle.allocationInLoops)
    }
    const sortFn = (
      a: { file: string; line: number },
      b: { file: string; line: number },
    ) => (a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.line - b.line)
    out.regexLiterals.sort(sortFn)
    out.tryCatchSwallows.sort(sortFn)
    out.awaitInLoops.sort(sortFn)
    out.allocationInLoops.sort(sortFn)
    return out
  },
)
