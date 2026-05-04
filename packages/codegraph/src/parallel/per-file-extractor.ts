// ADR-024
/**
 * Helper canonique pour porter les détecteurs per-file au pattern BSP.
 *
 * La majorité des détecteurs codegraph suivent le même pattern :
 *   1. Filtre les fichiers .ts/.tsx
 *   2. Read le contenu (I/O parallel)
 *   3. Pass à un extractor pure : (content, relPath) → Bundle
 *   4. Aggregate les bundles + sort par (file, line)
 *
 * `runPerFileExtractor` factorise ces 4 étapes en 1 appel, en utilisant
 * le scheduler BSP pour l'étape 3 (parallel + monoid) — gain CPU-bound
 * sur N cores quand le pool est utilisé. L'étape 4 est gratuite via
 * appendSortedMonoid.
 *
 * Théorème : si extractor est pure, runPerFileExtractor est déterministe
 * et bit-identique à la version séquentielle (Church-Rosser confluence
 * sur les pure fns + sort canonique).
 */

import { parallelMap, parallelMapWorkers } from './bsp-scheduler.js'
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
  /**
   * Mode worker_threads — opt-in via LIBY_BSP_WORKERS=1 ou explicit.
   * Si fourni, dispatch sur le pool global. Le caller doit fournir le
   * `workerModule` (path absolu vers le compiled .js) + `workerExport`
   * (nom de la fn, qui prend `{content, relPath}` et retourne `Item[]`).
   * Si non fourni, fallback sur le mode main thread (Promise.all).
   */
  workerModule?: string
  workerExport?: string
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
 * parallel, fusion via appendSortedMonoid (théorèmiquement déterministe).
 */
export async function runPerFileExtractor<Bundle, Item>(
  opts: PerFileExtractorOptions<Bundle, Item>,
): Promise<PerFileExtractorResult<Item>> {
  const exts = opts.extensions ?? ['.ts', '.tsx']
  const tsFiles = opts.files.filter((f) => exts.some((e) => f.endsWith(e)))
  const concurrency = opts.concurrency ?? 8
  const monoid = appendSortedMonoid<Item>(opts.sortKey)

  // Mode worker_threads : opt-in via env var LIBY_BSP_WORKERS=1. Le caller
  // doit aussi fournir workerModule + workerExport (closure pas sérialisable).
  // Default reste main thread Promise.all (sûr, déterministe, mêmes outputs).
  const useWorkers =
    process.env.LIBY_BSP_WORKERS === '1' &&
    opts.workerModule !== undefined &&
    opts.workerExport !== undefined

  if (useWorkers) {
    return await runViaWorkers<Bundle, Item>(opts, tsFiles, monoid)
  }

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

/**
 * Variante worker_threads — lit les fichiers en parallel main thread,
 * envoie {content, relPath} au worker pool qui calcule extract+select,
 * fusion monoïdale main thread.
 *
 * Pourquoi pas read DANS le worker : Node fs n'est pas vraiment plus
 * rapide en thread, et envoyer le path serait plus simple, mais le
 * pattern actuel laisse le main thread gérer l'I/O scheduling. Phase γ
 * pourra optimiser si besoin.
 */
async function runViaWorkers<Bundle, Item>(
  opts: PerFileExtractorOptions<Bundle, Item>,
  tsFiles: string[],
  monoid: ReturnType<typeof appendSortedMonoid<Item>>,
): Promise<PerFileExtractorResult<Item>> {
  void monoid  // intentionnel, parallelMapWorkers gère le fold
  // Read en parallel main thread, dispatch extract sur workers
  const inputs = await Promise.all(
    tsFiles.map(async (file) => ({ content: await opts.readFile(file), relPath: file })),
  )
  const r = await parallelMapWorkers<{ content: string; relPath: string }, Item[]>({
    items: inputs,
    workerModule: opts.workerModule!,
    workerExport: opts.workerExport!,
    monoid: appendSortedMonoid<Item>(opts.sortKey),
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
