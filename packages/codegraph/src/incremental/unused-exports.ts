/**
 * Incremental unused-exports — bundle per-file + agrégat global pure.
 *
 * Sprint 11.2 (Phase 3 complète). Le détecteur unused-exports était le
 * bottleneck warm dominant (~269ms = 71% du warm watcher) car il faisait
 * 4 passes globales sur tous les fichiers (~600 sur Sentinel) à chaque
 * run. Ce wrapper Salsa cache le bundle per-file (dérivé de fileContent)
 * et garde l'agrégat global pure — un changement d'1 fichier n'invalide
 * que ce fichier, l'agrégat re-compute mais en O(N) pur Map sans walk
 * AST.
 *
 * Cible : <20ms warm sur Sentinel. Préserve la parité bit-pour-bit avec
 * `analyzeExports` legacy (vérifiée par tests + snapshot diff).
 */

import { derived, input } from '@liby/salsa'
import {
  extractUnusedExportsFileBundle,
  aggregateBundles,
  classifyExportsFromBundles,
  type UnusedExportsFileBundle,
  type FileExportInfo,
  type TestFilesIndex,
} from '../extractors/unused-exports.js'
import { sharedDb as db } from './database.js'
import {
  fileContent,
  projectFiles,
  getIncrementalProject,
  getIncrementalRootDir,
} from './queries.js'
import * as path from 'node:path'

/**
 * Bundle per-file. Dépend uniquement de `fileContent(path)` côté Salsa,
 * donc cacheable proprement : un fichier modifié → recompute uniquement
 * ce fichier, les ~599 autres bundles restent en cache.
 */
export const unusedExportsBundleOfFile = derived<string, UnusedExportsFileBundle>(
  db, 'unusedExportsBundleOfFile',
  (filePath) => {
    fileContent.get(filePath)
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) {
      return {
        importedSymbols: [],
        namespaceTargets: [],
        stringLiteralSymbols: [],
        declaredExports: [],
      }
    }
    return extractUnusedExportsFileBundle(sf, filePath, rootDir, project)
  },
)

/**
 * Test files index — built async par `analyze()` puis set comme input
 * Salsa. Pas de Set inside (sérialisable JSON pour skip-set comparaison).
 */
export const testFilesIndexInput = input<string, TestFilesIndex>(db, 'unusedExportsTestIndex')

/**
 * Agrégat global — compose les bundles + l'index test, classifie tous
 * les exports. Pure : recompute O(N) sans I/O ni AST walk.
 */
export const allUnusedExports = derived<string, FileExportInfo[]>(
  db, 'allUnusedExports',
  (label) => {
    const files = projectFiles.get(label)
    const testIndex = testFilesIndexInput.get(label)

    const bundlesByFile = new Map<string, UnusedExportsFileBundle>()
    for (const f of files) {
      bundlesByFile.set(f, unusedExportsBundleOfFile.get(f))
    }

    const { importUsageMap, namespaceImporters, dynamicSymbolHits } =
      aggregateBundles(bundlesByFile)

    return classifyExportsFromBundles(
      [...files],
      bundlesByFile,
      importUsageMap,
      namespaceImporters,
      dynamicSymbolHits,
      testIndex,
    )
  },
)
