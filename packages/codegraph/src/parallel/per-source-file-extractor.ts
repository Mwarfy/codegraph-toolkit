/**
 * Helper BSP pour les détecteurs Project ts-morph partagé.
 *
 * Diff vs runPerFileExtractor (qui prend readFile callback) :
 *   - L'extractor reçoit un SourceFile ts-morph déjà parsé (pas le content
 *     string). Avantage : 0 re-parse, AST ré-utilisé entre détecteurs.
 *   - Le Project est partagé en mémoire — accédé concurrent en read-only,
 *     pas de mutation. Pure fns garanties par le contract.
 *
 * Pattern typique des détecteurs concernés :
 *   magic-numbers, hardcoded-secrets, deprecated-usage, complexity, etc.
 *
 * Théorème : si extractor est pure (read-only sur SourceFile), le résultat
 * parallel est bit-identique au sequential modulo sortFn. Confluence
 * Church-Rosser garantie sur les pure fns + monoïde commutatif.
 */

import type { Project, SourceFile } from 'ts-morph'
import { parallelMap } from './bsp-scheduler.js'
import { appendSortedMonoid } from './monoid.js'

export interface PerSourceFileExtractorOptions<Bundle, Item> {
  /** Project ts-morph partagé (déjà chargé). */
  project: Project
  /** Set des fichiers relatifs au rootDir (filtre les SourceFiles). */
  files: string[]
  /** Path racine pour relativiser les SourceFile paths. */
  rootDir: string
  /** Worker pure : (sf, relPath) → Bundle. Read-only sur sf. */
  extractor: (sf: SourceFile, relPath: string) => Bundle
  /** Selector qui extrait les items à aggréger depuis un Bundle. */
  selectItems: (bundle: Bundle) => Item[]
  /** Fonction qui retourne une clé canonique pour le tri post-merge. */
  sortKey: (item: Item) => string
  /** Predicate optionnel : skip un fichier (ex: tests, fixtures). */
  skipFile?: (relPath: string) => boolean
  /** Concurrence max — default 8. */
  concurrency?: number
}

export interface PerSourceFileExtractorResult<Item> {
  items: Item[]
  stats: {
    fileCount: number
    durationMs: number
    speedup: number
  }
}

export async function runPerSourceFileExtractor<Bundle, Item>(
  opts: PerSourceFileExtractorOptions<Bundle, Item>,
): Promise<PerSourceFileExtractorResult<Item>> {
  const fileSet = new Set(opts.files)
  const concurrency = opts.concurrency ?? 8
  const monoid = appendSortedMonoid<Item>(opts.sortKey)

  // Filtre upfront les SourceFiles qui matchent — itération synchrone légère.
  const sourceFiles: Array<{ sf: SourceFile; rel: string }> = []
  for (const sf of opts.project.getSourceFiles()) {
    const rel = relativize(sf.getFilePath(), opts.rootDir)
    if (!rel || !fileSet.has(rel)) continue
    if (opts.skipFile && opts.skipFile(rel)) continue
    sourceFiles.push({ sf, rel })
  }

  const r = await parallelMap({
    items: sourceFiles,
    workerFn: async ({ sf, rel }) => {
      const bundle = opts.extractor(sf, rel)
      return opts.selectItems(bundle)
    },
    monoid,
    concurrency,
  })

  return {
    items: r.result,
    stats: {
      fileCount: sourceFiles.length,
      durationMs: r.stats.durationMs,
      speedup: r.stats.speedup,
    },
  }
}

function relativize(absPath: string, rootDir: string): string | null {
  const normalized = absPath.replace(/\\/g, '/')
  const rootNormalized = rootDir.replace(/\\/g, '/')
  if (!normalized.startsWith(rootNormalized)) return null
  return normalized.slice(rootNormalized.length + 1)
}
