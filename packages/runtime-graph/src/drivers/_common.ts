// ADR-011
/**
 * Shared helpers for driver implementations (chaos, synthetic, replay-tests).
 *
 * Extracted via NCD detection (composite-near-duplicate-fn) — `parseRouteId`
 * + `readEntryPoints` étaient dupliqués entre chaos.ts et synthetic.ts.
 * `sleep` aussi (utilitaire trivial).
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export interface EntryPointRow {
  file: string
  kind: string
  id: string
}

/**
 * Lit le fichier `EntryPoint.facts` du dossier .codegraph et le parse en
 * lignes structurées. Retourne un array vide si le fichier n'existe pas
 * (ENOENT). Throw sur autres erreurs fs.
 */
export async function readEntryPoints(factsDir: string): Promise<EntryPointRow[]> {
  const file = path.join(factsDir, 'EntryPoint.facts')
  try {
    const content = await fs.readFile(file, 'utf-8')
    return content.split('\n').filter((l) => l.trim()).map((line) => {
      const [file, kind, id] = line.split('\t')
      return { file, kind, id }
    })
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

/**
 * Parse un EntryPoint id type "GET /api/foo" ou "/api/foo" (default GET).
 * Returns null si le format ne match pas.
 */
export function parseRouteId(id: string): { method: string; path: string } | null {
  const m = id.trim().match(/^([A-Z]+)\s+(\/.*)$/)
  if (m) return { method: m[1], path: m[2] }
  if (id.startsWith('/')) return { method: 'GET', path: id }
  return null
}

/** Promise-based sleep — utilitaire pour rate-limit / backoff dans drivers. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
