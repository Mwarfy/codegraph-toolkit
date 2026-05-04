// ADR-024
/**
 * Helper canonique pour porter les détecteurs per-file (readFile-based) au
 * pattern BSP monoïdal.
 *
 * La majorité des détecteurs codegraph readFile-based suivent le même pattern :
 *   1. Filtre les fichiers .ts/.tsx
 *   2. Read le contenu (I/O parallel)
 *   3. Pass à un extractor pure : (content, relPath) → Bundle
 *   4. Aggregate les bundles + sort par (file, line)
 *
 * `runPerFileExtractor` factorise ces 4 étapes en 1 appel, en utilisant le
 * scheduler BSP pour l'étape 3 (parallel + monoid). L'étape 4 est gratuite
 * via appendSortedMonoid.
 *
 * Théorème : si extractor est pure, runPerFileExtractor est déterministe et
 * bit-identique à la version séquentielle (Church-Rosser confluence sur les
 * pure fns + sort canonique).
 */

import { parallelMap } from './bsp-scheduler.js'
import { appendSortedMonoid } from './monoid.js'

export interface PerFileExtractorOptions<Bundle, Item> {
  /** Liste de fichiers à traiter (relatifs au rootDir). */
  files: string[]
  /** Fonction d'I/O — read file content depuis le fs. */
  readFile: (relPath: string) => Promise<string>
  /** Worker pure : (content, relPath) → Bundle. Doit être déterministe. */
  extractor: (content: string, relPath: string) => Bundle
  /** Selector qui extrait les items à aggréger depuis un Bundle. */
  selectItems: (bundle: Bundle) => Item[]
  /** Fonction qui retourne une clé canonique pour le tri post-merge. */
  sortKey: (item: Item) => string
  /** Concurrence max — default 8 (réaliste pour Node single-thread). */
  concurrency?: number
  /** Filter optionnel sur les extensions. Default : .ts + .tsx. */
  extensions?: string[]
}

export interface PerFileExtractorResult<Item> {
  items: Item[]
  stats: {
    fileCount: number
    durationMs: number
    speedup: number
  }
}

/**
 * Run un extractor pure sur tous les fichiers en parallel, agrège
 * monoïdalement avec ordre canonique. Gain : I/O reads + CPU extracts en
 * parallel main-thread, fusion via appendSortedMonoid.
 */
export async function runPerFileExtractor<Bundle, Item>(
  opts: PerFileExtractorOptions<Bundle, Item>,
): Promise<PerFileExtractorResult<Item>> {
  const exts = opts.extensions ?? ['.ts', '.tsx']
  const tsFiles = opts.files.filter((f) => exts.some((e) => f.endsWith(e)))
  const concurrency = opts.concurrency ?? 8
  const monoid = appendSortedMonoid<Item>(opts.sortKey)

  const r = await parallelMap({
    items: tsFiles,
    workerFn: async (file) => {
      const content = await opts.readFile(file)
      const bundle = opts.extractor(content, file)
      return opts.selectItems(bundle)
    },
    monoid,
    concurrency,
  })

  return {
    items: r.result,
    stats: {
      fileCount: tsFiles.length,
      durationMs: r.stats.durationMs,
      speedup: r.stats.speedup,
    },
  }
}
