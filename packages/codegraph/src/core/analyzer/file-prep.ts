// ADR-008
/**
 * File preparation helpers — extraits du god-file `core/analyzer.ts`
 * (split P3a). Stat parallèle + lecture conditionnelle (warm path =
 * stats only, pas de readFile inutile) + getGitHead pour invalidation
 * Salsa des détecteurs git-driven (co-change).
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  fileContent as incFileContent,
  getCachedMtime as incGetCachedMtime,
  setCachedMtime as incSetCachedMtime,
} from '../../incremental/queries.js'

/**
 * Récupère le SHA HEAD courant. Utilisé comme clé d'invalidation Salsa
 * pour les détecteurs git-driven (co-change). Retourne `''` si le repo
 * n'est pas git ou si git n'est pas installé — Salsa traitera cette
 * "absence" comme une key stable.
 */
export function getGitHead(rootDir: string): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: rootDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return ''
  }
}

export interface FileStatEntry { f: string; absPath: string; mtime: number | undefined }

export async function statFilesParallel(rootDir: string, files: string[]): Promise<FileStatEntry[]> {
  return Promise.all(
    files.map(async (f) => {
      const absPath = path.join(rootDir, f)
      try {
        const stat = await fs.stat(absPath)
        return { f, absPath, mtime: stat.mtimeMs }
      } catch { return { f, absPath, mtime: undefined as number | undefined } }
    }),
  )
}

/**
 * Filtre les files pour ne lire que ceux qui ont VRAIMENT change
 * (mtime ≠ cached) ou qui ne sont pas encore dans la cell. Le warm
 * path (rien change) ne fait QUE des stats — pas de readFile gaspille.
 */
export function filterFilesToRead(stats: FileStatEntry[]): FileStatEntry[] {
  const toRead: FileStatEntry[] = []
  for (const entry of stats) {
    const { f, mtime } = entry
    const cachedMtime = incGetCachedMtime(f)
    const cellExists = incFileContent.has(f)
    if (mtime !== undefined && cachedMtime === mtime && cellExists) continue
    toRead.push(entry)
  }
  return toRead
}

export async function readAndCacheFiles(toRead: FileStatEntry[], fileCache: Map<string, string>): Promise<void> {
  const reads = await Promise.all(
    toRead.map(async ({ f, absPath, mtime }) => {
      let content = fileCache.get(f)
      if (content === undefined) {
        try { content = await fs.readFile(absPath, 'utf-8') } catch { content = '' }
      }
      return { f, mtime, content }
    }),
  )
  for (const { f, mtime, content } of reads) {
    fileCache.set(f, content)
    incFileContent.set(f, content)
    if (mtime !== undefined) incSetCachedMtime(f, mtime)
  }
}
