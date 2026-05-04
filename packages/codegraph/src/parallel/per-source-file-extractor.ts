// ADR-024
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
 *
 * Phase γ.2 — Mode worker_threads (opt-in via LIBY_BSP_WORKERS=1) :
 *   - Le caller fournit `workerModule` + `workerExport` qui pointent vers
 *     une fn `(sf, relPath, options?) => Item[]` exportée du compiled .js.
 *   - Le runner spawne N workers (cf. worker-pool.ts), chaque worker crée
 *     un mini-Project ts-morph local (useInMemoryFileSystem) avec 1 seule
 *     SourceFile, puis appelle l'extractor.
 *   - Coût : ~10-30ms re-parse par fichier × N cores. Crossover ROI ~50
 *     fichiers — en-dessous, main thread plus rapide (pas de re-parse).
 *   - Le mini-Project ne contient QUE le file traité — donc pas de
 *     résolution cross-file (typeChecker, imports). Les détecteurs
 *     dépendant du symbol table cross-file (ts-imports, deprecated-usage)
 *     restent main thread.
 */

import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import type { Project, SourceFile } from 'ts-morph'
import { parallelMap, parallelMapWorkers } from './bsp-scheduler.js'
import { appendSortedMonoid } from './monoid.js'
import { decideWorkerMode } from './cost-model.js'

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
  /**
   * Phase γ.2 — Mode worker_threads (opt-in via LIBY_BSP_WORKERS=1).
   * Si fourni, le scheduler dispatche sur le pool global :
   *   - workerModule : path absolu vers le compiled .js qui exporte la fn
   *   - workerExport : nom de la fn `(sf, relPath, options?) => Item[]`
   *   - workerExtractorOptions : 3e arg passé à la fn (e.g. threshold)
   * Si non fourni, fallback sur le mode main thread (Promise.all sur le
   * Project partagé). Le cost-model décide d'activer ou non.
   */
  workerModule?: string
  workerExport?: string
  workerExtractorOptions?: unknown
}

export interface PerSourceFileExtractorResult<Item> {
  items: Item[]
  stats: {
    fileCount: number
    durationMs: number
    speedup: number
  }
}

function resolveRunnerPath(): string {
  const env = process.env.LIBY_BSP_SOURCE_FILE_RUNNER
  if (env) return env
  // Cas normal : import.meta.url pointe vers le compiled .js dans dist/
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.join(here, 'source-file-worker-runner.js')
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

  // Phase γ.2 — décider mode worker via cost-model si workerModule fourni.
  let useWorkers = false
  if (opts.workerModule !== undefined && opts.workerExport !== undefined) {
    const decision = await decideWorkerMode({
      projectRoot: opts.rootDir,
      fileCount: sourceFiles.length,
    })
    useWorkers = decision === 'workers'
  }

  if (useWorkers) {
    return await runViaWorkers<Bundle, Item>(opts, sourceFiles, monoid)
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

/**
 * Phase γ.2 — Variante worker_threads pour les détecteurs Project ts-morph.
 *
 * Sérialise le content (string) main thread, dispatch sur N workers qui
 * créent chacun un mini-Project local et re-parsent le file. Coût re-parse
 * × N, mais gain × cores réels sur l'extraction.
 */
async function runViaWorkers<Bundle, Item>(
  opts: PerSourceFileExtractorOptions<Bundle, Item>,
  sourceFiles: Array<{ sf: SourceFile; rel: string }>,
  monoid: ReturnType<typeof appendSortedMonoid<Item>>,
): Promise<PerSourceFileExtractorResult<Item>> {
  void monoid  // intentionnel, parallelMapWorkers gère le fold
  // Sérialise le content + path main thread (pas de Project cross-thread).
  const inputs = sourceFiles.map(({ sf, rel }) => ({
    absPath: sf.getFilePath(),
    content: sf.getFullText(),
    relPath: rel,
    extractorModule: opts.workerModule!,
    extractorExport: opts.workerExport!,
    extractorOptions: opts.workerExtractorOptions,
  }))

  const r = await parallelMapWorkers<typeof inputs[number], Item[]>({
    items: inputs,
    workerModule: resolveRunnerPath(),
    workerExport: 'extractInWorker',
    monoid: appendSortedMonoid<Item>(opts.sortKey),
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
