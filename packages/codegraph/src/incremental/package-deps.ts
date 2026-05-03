// ADR-007
/**
 * Incremental package-deps — wrap Salsa autour du scan AST + regex
 * runtime-asset.
 *
 * Particularité par rapport à env-usage : la discovery des
 * `package.json` est async (lecture filesystem) → faite hors-Salsa
 * dans `analyze()`, le résultat est passé via `packageManifestsInput`.
 *
 * Le matching declared-vs-imported (logique pure) tourne dans
 * l'agrégateur. Le COÛT DOMINANT est l'AST scan par fichier — c'est ce
 * qui se cache, et c'est ce qui apporte le speed-up incremental.
 */

import { derived } from '@liby-tools/salsa'
import {
  collectPackageRefsInSourceFile,
  buildPackageDepsIssues,
  findClosestManifest,
  DEFAULT_TEST_RES,
  type PackageManifest,
} from '../extractors/package-deps.js'
import type { PackageDepsIssue } from '../core/types.js'
import { sharedDb as db } from './database.js'
import {
  fileContent,
  projectFiles,
  packageManifestsInput,
  getIncrementalProject,
  getIncrementalRootDir,
} from './queries.js'
import * as path from 'node:path'

/** Imports + runtime asset refs pour UN fichier. Cached via fileContent. */
export const packageRefsOfFile = derived<string, { imports: string[]; runtimeAssets: string[] }>(
  db, 'packageRefsOfFile',
  (filePath) => {
    fileContent.get(filePath)
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) return { imports: [], runtimeAssets: [] }
    return collectPackageRefsInSourceFile(sf)
  },
)

export const allPackageDeps = derived<string, PackageDepsIssue[]>(
  db, 'allPackageDeps',
  (label) => {
    const files = projectFiles.get(label)
    const manifests = packageManifestsInput.get(label) as PackageManifest[]
    if (!manifests || manifests.length === 0) return []
    const rootDir = getIncrementalRootDir()

    // Reconstruct scope-filtered active set : tous les manifests passés en
    // input sont déjà filtrés "active" par analyze().
    const active = manifests
    const importsByManifest = new Map<string, Map<string, Set<string>>>()
    const runtimeAssetsByManifest = new Map<string, Map<string, Set<string>>>()
    for (const m of active) {
      importsByManifest.set(m.abs, new Map())
      runtimeAssetsByManifest.set(m.abs, new Map())
    }

    for (const f of files) {
      const absPath = path.join(rootDir, f)
      const manifest = findClosestManifest(absPath, active)
      if (!manifest) continue
      const refs = packageRefsOfFile.get(f)

      const importBucket = importsByManifest.get(manifest.abs)!
      for (const pkg of refs.imports) {
        if (!importBucket.has(pkg)) importBucket.set(pkg, new Set())
        importBucket.get(pkg)!.add(f)
      }
      const assetBucket = runtimeAssetsByManifest.get(manifest.abs)!
      for (const pkg of refs.runtimeAssets) {
        if (!assetBucket.has(pkg)) assetBucket.set(pkg, new Set())
        assetBucket.get(pkg)!.add(f)
      }
    }

    return buildPackageDepsIssues(active, importsByManifest, runtimeAssetsByManifest, DEFAULT_TEST_RES)
  },
)
