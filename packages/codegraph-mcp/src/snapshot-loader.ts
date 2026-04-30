/**
 * Snapshot loader — charge le dernier `.codegraph/snapshot-*.json` avec
 * mtime cache pour éviter de re-parser à chaque tool call.
 *
 * Le snapshot est régénéré post-commit (~7s) et change rarement durant
 * une session. On cache en RAM, refresh sur changement de mtime.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

let cachedSnapshot: any = null
let cachedMtime = 0
let cachedPath = ''

export function loadSnapshot(repoRoot: string): any {
  const codegraphDir = path.join(repoRoot, '.codegraph')
  let files: string[]
  try {
    files = fs.readdirSync(codegraphDir)
      .filter(f => f.startsWith('snapshot-') && f.endsWith('.json'))
      .sort()
  } catch {
    throw new Error(`No .codegraph directory at ${repoRoot}. Run \`npx codegraph analyze\` first.`)
  }
  if (files.length === 0) {
    throw new Error(`No snapshot found in ${codegraphDir}. Run \`npx codegraph analyze\` first.`)
  }
  const latestPath = path.join(codegraphDir, files[files.length - 1])
  const stat = fs.statSync(latestPath)
  if (cachedPath === latestPath && cachedMtime === stat.mtimeMs && cachedSnapshot) {
    return cachedSnapshot
  }
  cachedSnapshot = JSON.parse(fs.readFileSync(latestPath, 'utf-8'))
  cachedMtime = stat.mtimeMs
  cachedPath = latestPath
  return cachedSnapshot
}

export function clearCache(): void {
  cachedSnapshot = null
  cachedMtime = 0
  cachedPath = ''
}

/**
 * Normalise un path absolu OU relatif au rootDir vers le format
 * `nodes[].id` du snapshot (relatif à la racine).
 */
export function toRelPath(repoRoot: string, p: string): string {
  if (path.isAbsolute(p)) {
    const rel = path.relative(repoRoot, p).replace(/\\/g, '/')
    return rel
  }
  return p.replace(/\\/g, '/')
}
