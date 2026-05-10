// ADR-008
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

// ADR-027
/**
 * Charge le snapshot le plus frais. Phase 2 d'ADR-027 — privilégie
 * `.codegraph/snapshot.json` (wrapper v2 { version, meta, payload }),
 * fallback sur les `snapshot-*.json` legacy par mtime pour les
 * checkouts pré-migration.
 */
export function loadSnapshot(repoRoot: string): any {
  const codegraphDir = path.join(repoRoot, '.codegraph')

  // V2 path : .codegraph/snapshot.json
  const v2Path = path.join(codegraphDir, 'snapshot.json')
  let v2Stat: fs.Stats | null = null
  try {
    v2Stat = fs.statSync(v2Path)
  } catch { /* try legacy */ }

  if (v2Stat) {
    if (cachedPath === v2Path && cachedMtime === v2Stat.mtimeMs && cachedSnapshot) {
      return cachedSnapshot
    }
    const parsed = JSON.parse(fs.readFileSync(v2Path, 'utf-8'))
    const payload = (parsed && parsed.version === 2 && parsed.payload) ? parsed.payload : parsed
    cachedSnapshot = payload
    cachedMtime = v2Stat.mtimeMs
    cachedPath = v2Path
    return cachedSnapshot
  }

  // Legacy path : snapshot-<ts>-<sha>.json le plus frais par mtime.
  let files: string[]
  try {
    files = fs.readdirSync(codegraphDir)
      .filter(f => /^snapshot-\d{4}-\d{2}-\d{2}T.*\.json$/.test(f))
  } catch {
    throw new Error(`No .codegraph directory at ${repoRoot}. Run \`npx codegraph analyze\` first.`)
  }
  if (files.length === 0) {
    throw new Error(`No snapshot found in ${codegraphDir}. Run \`npx codegraph analyze\` first.`)
  }
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
