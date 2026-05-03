// ADR-007
/**
 * Incremental crypto-algo — Salsa wrapper around the per-file AST scan
 * for crypto API call sites (createHash, randomBytes, ...).
 */

import { derived } from '@liby-tools/salsa'
import {
  extractCryptoCallsFileBundle,
  type CryptoCallsFileBundle,
  type CryptoCall,
} from '../extractors/crypto-algo.js'
import { sharedDb as db } from './database.js'
import {
  fileContent,
  projectFiles,
  getIncrementalProject,
  getIncrementalRootDir,
} from './queries.js'
import * as path from 'node:path'

export const cryptoCallsOfFile = derived<string, CryptoCallsFileBundle>(
  db,
  'cryptoCallsOfFile',
  (filePath) => {
    fileContent.get(filePath)
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) return { calls: [] }
    return extractCryptoCallsFileBundle(sf, filePath)
  },
)

export const allCryptoCalls = derived<string, CryptoCall[]>(
  db,
  'allCryptoCalls',
  (label) => {
    const files = projectFiles.get(label)
    const out: CryptoCall[] = []
    for (const f of files) {
      out.push(...cryptoCallsOfFile.get(f).calls)
    }
    out.sort((a, b) => {
      if (a.file !== b.file) return a.file < b.file ? -1 : 1
      return a.line - b.line
    })
    return out
  },
)
