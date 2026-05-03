// ADR-007
/**
 * Incremental data-flows — bundle per-file (sinks + entries +
 * inlineListenerSinks) + builder pure global.
 *
 * Architecture :
 *   - `dataFlowsBundleOfFile(path)` : derived → bundle per-file.
 *     Cache via fileContent.
 *   - `allDataFlows(label)` : derived qui assemble les bundles +
 *     typedCalls (passé en input pour ne pas créer une dep cyclique
 *     avec Salsa) puis appelle buildDataFlowsFromBundles() pure.
 */

import { derived, input } from '@liby-tools/salsa'
import {
  extractDataFlowsFileBundle,
  buildDataFlowsFromBundles,
  DEFAULT_DATA_FLOWS_OPTS,
  type DataFlowFileBundle,
} from '../extractors/data-flows.js'
import type { DataFlow, TypedCalls } from '../core/types.js'
import { sharedDb as db } from './database.js'
import {
  fileContent,
  projectFiles,
  getIncrementalProject,
  getIncrementalRootDir,
} from './queries.js'
import * as path from 'node:path'

const DEFAULT_MAX_DEPTH = 10
const DEFAULT_DOWNSTREAM_DEPTH = 3

/** TypedCalls résolu au global, set par analyze() avant data-flows. */
export const typedCallsInput = input<string, TypedCalls>(db, 'typedCallsInput')

export const dataFlowsBundleOfFile = derived<string, DataFlowFileBundle>(
  db, 'dataFlowsBundleOfFile',
  (filePath) => {
    fileContent.get(filePath)
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) {
      return {
        sinksByContainer: new Map(),
        entries: [],
        inlineListenerSinks: new Map(),
      }
    }
    return extractDataFlowsFileBundle(sf, filePath, DEFAULT_DATA_FLOWS_OPTS)
  },
)

export const allDataFlows = derived<string, DataFlow[]>(
  db, 'allDataFlows',
  (label) => {
    const files = projectFiles.get(label)
    const typedCalls = typedCallsInput.has(label)
      ? typedCallsInput.get(label)
      : { signatures: [], callEdges: [] }

    const bundles = new Map<string, DataFlowFileBundle>()
    for (const f of files) {
      bundles.set(f, dataFlowsBundleOfFile.get(f))
    }
    return buildDataFlowsFromBundles(bundles, typedCalls, {
      maxDepth: DEFAULT_MAX_DEPTH,
      downstreamDepth: DEFAULT_DOWNSTREAM_DEPTH,
    })
  },
)
