/**
 * Incremental typed-calls — bundle per-file (signatures + raw call edges)
 * agrégé via aggregateTypedCalls qui filtre par knownExports global.
 */

import { derived } from '@liby-tools/salsa'
import {
  extractTypedCallsFileBundle,
  aggregateTypedCalls,
  type TypedCallsFileBundle,
} from '../extractors/typed-calls.js'
import type { TypedCalls } from '../core/types.js'
import { sharedDb as db } from './database.js'
import {
  fileContent,
  projectFiles,
  getIncrementalProject,
  getIncrementalRootDir,
} from './queries.js'
import * as path from 'node:path'

export const typedCallsBundleOfFile = derived<string, TypedCallsFileBundle>(
  db, 'typedCallsBundleOfFile',
  (filePath) => {
    fileContent.get(filePath)
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) return { signatures: [], rawCallEdges: [] }
    return extractTypedCallsFileBundle(sf, filePath, rootDir)
  },
)

export const allTypedCalls = derived<string, TypedCalls>(
  db, 'allTypedCalls',
  (label) => {
    const files = projectFiles.get(label)
    const bundles = new Map<string, TypedCallsFileBundle>()
    for (const f of files) {
      bundles.set(f, typedCallsBundleOfFile.get(f))
    }
    return aggregateTypedCalls(bundles)
  },
)
