/**
 * Incremental truth-points — wrap Salsa autour du bundle per-file +
 * agrégation cross-file qui dépend des graph edges.
 *
 * Architecture :
 *   - `truthPointsBundleOfFile(path)` : derived → tous les signaux
 *     (sql, redis, memory, exportedFns) extractibles d'UN fichier.
 *     Cache via fileContent.
 *   - `graphEdgesInput(label)` : input → GraphEdge[]. Set par
 *     analyze() après que le graph soit construit.
 *   - `allTruthPoints(label)` : croise les bundles + edges, build via
 *     le helper pure.
 */

import { derived, input } from '@liby/salsa'
import {
  extractTruthPointsFileBundle,
  buildTruthPointsFromSignals,
  type TruthPointsFileBundle,
} from '../extractors/truth-points.js'
import type { TruthPoint, GraphEdge } from '../core/types.js'
import { sharedDb as db } from './database.js'
import {
  fileContent,
  projectFiles,
  getIncrementalProject,
  getIncrementalRootDir,
} from './queries.js'
import * as path from 'node:path'

const DEFAULT_REDIS_VARS = new Set(['redis', 'client', 'pipeline', 'pipe'])
const DEFAULT_MEM_SUFFIXES = ['Cache', 'Store', 'Registry']
const DEFAULT_MEM_CTORS = new Set(['Map', 'LRUCache', 'WeakMap', 'LRU'])
const DEFAULT_EXPOSED_PREFIXES = ['get', 'find', 'read', 'list']

export const graphEdgesInput = input<string, readonly GraphEdge[]>(db, 'graphEdges')

export const truthPointsBundleOfFile = derived<string, TruthPointsFileBundle>(
  db, 'truthPointsBundleOfFile',
  (filePath) => {
    fileContent.get(filePath)
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) return { sql: [], redis: [], memory: [], exportedFns: [] }
    return extractTruthPointsFileBundle(
      sf, filePath,
      DEFAULT_REDIS_VARS,
      DEFAULT_MEM_SUFFIXES,
      DEFAULT_MEM_CTORS,
      DEFAULT_EXPOSED_PREFIXES,
    )
  },
)

export const allTruthPoints = derived<string, TruthPoint[]>(
  db, 'allTruthPoints',
  (label) => {
    const files = projectFiles.get(label)
    const edges = graphEdgesInput.has(label)
      ? graphEdgesInput.get(label) as GraphEdge[]
      : []

    const sql: TruthPointsFileBundle['sql'] = []
    const redis: TruthPointsFileBundle['redis'] = []
    const memory: TruthPointsFileBundle['memory'] = []
    const exportedFns: TruthPointsFileBundle['exportedFns'] = []

    for (const f of files) {
      const bundle = truthPointsBundleOfFile.get(f)
      sql.push(...bundle.sql)
      redis.push(...bundle.redis)
      memory.push(...bundle.memory)
      exportedFns.push(...bundle.exportedFns)
    }

    const fileSet = new Set(files)
    return buildTruthPointsFromSignals(
      [...files], sql, redis, memory, exportedFns,
      edges, fileSet, {}, DEFAULT_MEM_SUFFIXES,
    )
  },
)
