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
  } catch {
    throw new Error(`No .codegraph directory at ${repoRoot}. Run \`npx codegraph analyze\` first.`)
  }
  if (files.length === 0) {
    throw new Error(`No snapshot found in ${codegraphDir}. Run \`npx codegraph analyze\` first.`)
  }
  // Sprint B2 : tri par mtime descendant — préfère le snapshot le plus
  // frais. Ainsi `snapshot-live.json` (réécrit en continu par
  // `codegraph watch`) gagne sur `snapshot-2026-...-COMMIT.json`
  // (post-commit, donc plus ancien dès qu'on a édité un fichier).
  // Si pas de watcher actif, le post-commit le plus récent gagne —
  // comportement inchangé vs avant B2.
  const filesWithMtime = files.map((f) => {
    const p = path.join(codegraphDir, f)
    return { path: p, mtime: fs.statSync(p).mtimeMs }
  })
  filesWithMtime.sort((a, b) => b.mtime - a.mtime)
  const latestPath = filesWithMtime[0].path
  const stat = fs.statSync(latestPath)
  if (cachedPath === latestPath && cachedMtime === stat.mtimeMs && cachedSnapshot) {
    return cachedSnapshot
  }
  cachedSnapshot = JSON.parse(fs.readFileSync(latestPath, 'utf-8'))
  cachedMtime = stat.mtimeMs
  cachedPath = latestPath
  return cachedSnapshot
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
