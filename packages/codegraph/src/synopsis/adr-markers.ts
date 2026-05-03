/**
 * Collecte des marqueurs `// ADR-NNN` du code source pour enrichir le synopsis.
 *
 * Source-of-truth inverted : code → ADRs. Les ADRs sont tagged sur les nodes
 * du synopsis. Les hubs sans aucun marqueur sont signalés en "Suggestions".
 *
 * Format de marqueur accepté (même que scripts/regenerate-adr-anchors.ts à la
 * racine projet — convention partagée) :
 *   // ADR-013                         (TS, début de commentaire)
 *   // ADR-013, ADR-018                (multi-ADR)
 *   # ADR-013                          (shell/sql)
 *   /* ADR-013 *\/                     (block comment)
 *
 * Les références prose (`cf. ADR-013 pour ...`) ne matchent PAS — pour éviter
 * les faux positifs.
 */

import { readFile, readdir } from 'node:fs/promises'
import * as path from 'node:path'

const ANCHOR_LINE = /^\s*(?:\/\/|#|\*)\s*(ADR-\d{3}(?:\s*[:,\-—]?\s*ADR-\d{3})*)\s*(?::\s*(.+))?$/
const ADR_NUM = /ADR-(\d{3})/g

export interface CollectOptions {
  /** Default skip list — extensible via param. */
  skipDirs?: Set<string>
  /** Extensions à scanner. Default : ts/sh/sql. */
  extensions?: Set<string>
}

const DEFAULT_SKIP = new Set([
  'node_modules', 'dist', '.git', '.codegraph', 'coverage', '.next',
  'docker-data', 'docker-data-prod', '.deploy-queue', 'logs',
])

const DEFAULT_EXT = new Set(['ts', 'sh', 'sql'])

/**
 * Walk le repo et retourne `Map<fileId, ADR_numbers[]>`.
 * Le `fileId` est le path relatif au `repoRoot` (matche les `node.id` du
 * snapshot codegraph).
 */
export async function collectAdrMarkers(
  repoRoot: string,
  options: CollectOptions = {},
): Promise<Map<string, string[]>> {
  const skipDirs = options.skipDirs ?? DEFAULT_SKIP
  const extensions = options.extensions ?? DEFAULT_EXT
  const out = new Map<string, string[]>()

  async function walk(dir: string): Promise<void> {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    // Sub-dirs récursés en parallèle, files lus en parallèle (push partagé OK).
    const subdirs: string[] = []
    const fileTasks: Array<Promise<void>> = []
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.github') continue
      if (skipDirs.has(e.name)) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        subdirs.push(full)
      } else if (e.isFile()) {
        const ext = e.name.split('.').pop() || ''
        if (!extensions.has(ext)) continue
        fileTasks.push((async () => {
          const content = await readFile(full, 'utf-8')
          const adrs = new Set<string>()
          for (const line of content.split('\n')) {
            const m = line.match(ANCHOR_LINE)
            if (!m) continue
            for (const tok of m[1].matchAll(ADR_NUM)) adrs.add(tok[1])
          }
          if (adrs.size > 0) {
            const rel = path.relative(repoRoot, full)
            out.set(rel, [...adrs].sort())
          }
        })())
      }
    }
    await Promise.all([...fileTasks, ...subdirs.map((sd) => walk(sd))])
  }
  await walk(repoRoot)
  return out
}
