// ADR-008
/**
 * File discovery — walk filesystem récursif + filtrage include/exclude.
 *
 * Extrait de `analyzer.ts` (god-file split, refactor 2026-05) pour réduire
 * la taille du fichier monolithique sans changer le comportement. API
 * publique : `discoverFiles(rootDir, include, exclude) → string[]`.
 *
 * Comportement :
 *   - Skip les directories lourdes connues (node_modules, .git, dist,
 *     build, .next, coverage, .turbo, .cache, docker-data) AVANT lecture.
 *   - Émet les paths relatifs au rootDir, séparateur '/' (cross-platform).
 *   - Filtre via minimatch sur include puis exclude (exclude prioritaire).
 *   - Retourne la liste DANS L'ORDRE DE WALK fs.readdir — l'analyzer la
 *     trie ensuite si besoin pour son déterminisme.
 *
 * Cas connus : si rootDir lui-même est dans skipDirs (ex: analyser un
 * checkout dans /tmp/node_modules/foo), on autorise le 1er niveau via
 * `dir !== rootDir`. Évite un short-circuit unwanted.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { minimatch } from 'minimatch'

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next',
  'coverage', '.turbo', '.cache', 'docker-data',
])

export async function discoverFiles(
  rootDir: string,
  include: string[],
  exclude: string[],
): Promise<string[]> {
  const allFiles: string[] = []
  await walkDir(rootDir, rootDir, allFiles)

  return allFiles.filter((file) => {
    const matches = include.some((pattern) => minimatch(file, pattern))
    const excluded = exclude.some((pattern) => minimatch(file, pattern))
    return matches && !excluded
  })
}

async function walkDir(
  dir: string,
  rootDir: string,
  result: string[],
): Promise<void> {
  const dirName = path.basename(dir)
  if (SKIP_DIRS.has(dirName) && dir !== rootDir) return

  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkDir(fullPath, rootDir, result)
    } else if (entry.isFile()) {
      const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/')
      result.push(relativePath)
    }
  }
}
