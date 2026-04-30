/**
 * Incremental event-emit-sites — wrap Salsa autour du scan AST des
 * `emit({ type: ... })`.
 *
 * Pattern symétrique à env-usage : helper per-file
 * `scanEmitSitesInSourceFile` (extrait du legacy) + queries Salsa.
 *
 * Usage primaire : facts Datalog `EmitsEventLiteral` / `EmitsEventConst`
 * qui drivent ADR-017 (event names typés).
 */

import { derived } from '@liby/salsa'
import {
  scanEmitSitesInSourceFile,
  DEFAULT_EMIT_NAMES,
  type EventEmitSite,
} from '../extractors/event-emit-sites.js'
import { sharedDb as db } from './database.js'
import {
  fileContent,
  projectFiles,
  getIncrementalProject,
  getIncrementalRootDir,
} from './queries.js'
import * as path from 'node:path'

export const eventEmitSitesOfFile = derived<string, EventEmitSite[]>(
  db, 'eventEmitSitesOfFile',
  (filePath) => {
    fileContent.get(filePath)  // dep tracking
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) return []
    return scanEmitSitesInSourceFile(sf, filePath, DEFAULT_EMIT_NAMES)
  },
)

export const allEventEmitSites = derived<string, EventEmitSite[]>(
  db, 'allEventEmitSites',
  (label) => {
    const files = projectFiles.get(label)
    const out: EventEmitSite[] = []
    for (const f of files) {
      out.push(...eventEmitSitesOfFile.get(f))
    }
    out.sort((a, b) => {
      if (a.file !== b.file) return a.file < b.file ? -1 : 1
      return a.line - b.line
    })
    return out
  },
)
