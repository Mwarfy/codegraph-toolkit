// ADR-007
/**
 * Incremental hardcoded-secrets — Salsa wrapper around the per-file AST
 * scan for hardcoded API keys, credentials, AWS access tokens, etc.
 *
 * Self-optim discovery (run #2) : ce détecteur sort hot warm en suite
 * (mean=222ms, λ_lyap=1.00) — preuve mathématique de zéro cache. Pattern
 * Salsa identique à code-quality-patterns / constant-expressions /
 * security-patterns (per-file bundle keyé sur fileContent).
 */

import { derived } from '@liby-tools/salsa'
import {
  extractHardcodedSecretsFileBundle,
  type HardcodedSecretsFileBundle,
  type HardcodedSecret,
} from '../extractors/hardcoded-secrets.js'
import { sharedDb as db } from './database.js'
import {
  fileContent,
  projectFiles,
  getIncrementalProject,
  getIncrementalRootDir,
} from './queries.js'
import * as path from 'node:path'

/** Per-file bundle — cached on fileContent. */
export const hardcodedSecretsOfFile = derived<string, HardcodedSecretsFileBundle>(
  db,
  'hardcodedSecretsOfFile',
  (filePath) => {
    fileContent.get(filePath)                                              // dep tracking
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) return { secrets: [] }
    return extractHardcodedSecretsFileBundle(sf, filePath)
  },
)

/** Global aggregator — combine tous les per-file bundles + tri stable. */
export const allHardcodedSecrets = derived<string, HardcodedSecret[]>(
  db,
  'allHardcodedSecrets',
  (label) => {
    const files = projectFiles.get(label)
    const out: HardcodedSecret[] = []
    for (const f of files) {
      const bundle = hardcodedSecretsOfFile.get(f)
      out.push(...bundle.secrets)
    }
    out.sort((a, b) => {
      if (a.file !== b.file) return a.file < b.file ? -1 : 1
      return a.line - b.line
    })
    return out
  },
)
