// ADR-024
/**
 * Worker entrypoint générique pour les détecteurs Project ts-morph
 * (Phase γ.2 + γ.3 BSP).
 *
 * Reçoit { absPath, content, relPath, extractorModule, extractorExport,
 *          extractorOptions? } via parallelMapWorkers. Crée un mini-Project
 * ts-morph local au worker (1 SourceFile), appelle l'extractor pure,
 * retourne items.
 *
 * Phase γ.3 — Cache LRU du mini-Project par (absPath, content-hash) :
 *   Sans cache, 11 détecteurs × N fichiers = 11×N parses. Avec cache LRU
 *   par worker, le même file traité par detector_1 puis detector_2 ne
 *   re-parse qu'une fois (les détecteurs subséquents lisent le SourceFile
 *   du cache). Sur 4 workers et 175 files toolkit : 4 × 175 / 11 = ~64
 *   parses au lieu de 4 × 175 × 11 = 7700. Gain réel ~120×.
 *
 * Limites par design :
 *   - Le mini-Project ne contient QUE le file traité. Pas de résolution
 *     cross-file (imports, type checking sur d'autres modules) → exclu pour
 *     les détecteurs comme ts-imports, qui restent main-thread.
 *   - Le cache est par-worker (pas partagé cross-thread). Un fichier peut
 *     être re-parsé une fois par worker dans le pire cas.
 *
 * Coût : ~10-30ms parse per file (cache miss), ~0ms cache hit.
 * Gain attendu : sur N détecteurs same-file, N → 1 parse → ×N gain CPU.
 */

import { createHash } from 'node:crypto'
import { Project, type SourceFile } from 'ts-morph'
import { pathToFileURL } from 'node:url'

interface WorkerInput {
  absPath: string
  content: string
  relPath: string
  /** Module path à importer dans le worker — typiquement le compiled extractor. */
  extractorModule: string
  /** Nom de l'export (extract*FileBundle ou similar). */
  extractorExport: string
  /** Options optionnelles passées à l'extractor (3e arg). */
  extractorOptions?: unknown
}

const moduleCache = new Map<string, Promise<Record<string, unknown>>>()

async function loadExtractorModule(modulePath: string): Promise<Record<string, unknown>> {
  let mod = moduleCache.get(modulePath)
  if (!mod) {
    const url = modulePath.startsWith('file://') ? modulePath : pathToFileURL(modulePath).href
    mod = import(url) as Promise<Record<string, unknown>>
    moduleCache.set(modulePath, mod)
  }
  return mod
}

// ─── Phase γ.3 — Mini-Project LRU cache ─────────────────────────────────────

/**
 * Cache LRU des SourceFile parsés. Key = `${absPath}:${content-sha1-prefix}`.
 * Si le content change (edit), la clé change → eviction implicite + re-parse.
 *
 * Size cap ~256 entries par worker — ~50KB AST × 256 = ~13MB par worker,
 * acceptable. Au-delà, eviction LRU naïve (Map insertion order = LRU).
 */
const MAX_CACHE_ENTRIES = 256

interface CachedEntry {
  project: Project
  sourceFile: SourceFile
}

const sourceFileCache = new Map<string, CachedEntry>()

function cacheKey(absPath: string, content: string): string {
  // SHA1 prefix (16 chars) suffit pour distinguer les contents — on n'a pas
  // besoin d'une signature crypto, juste d'un changement détectable.
  const hash = createHash('sha1').update(content).digest('hex').slice(0, 16)
  return `${absPath}:${hash}`
}

function getOrCreateSourceFile(absPath: string, content: string): SourceFile {
  const key = cacheKey(absPath, content)
  const cached = sourceFileCache.get(key)
  if (cached) {
    // Move-to-end pour LRU (Map preserve l'ordre d'insertion).
    sourceFileCache.delete(key)
    sourceFileCache.set(key, cached)
    return cached.sourceFile
  }

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true, resolveJsonModule: true },
  })
  const sourceFile = project.createSourceFile(absPath, content, { overwrite: true })

  // Eviction LRU si on dépasse le cap.
  if (sourceFileCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = sourceFileCache.keys().next().value
    if (oldestKey !== undefined) sourceFileCache.delete(oldestKey)
  }
  sourceFileCache.set(key, { project, sourceFile })
  return sourceFile
}

/**
 * Worker fn appelée par worker-runner.ts via dynamic dispatch.
 *
 * Retourne le résultat brut de l'extractor (Bundle ou Item[]) — le caller
 * fait selectItems main thread.
 */
export async function extractInWorker(input: WorkerInput): Promise<unknown> {
  const sf = getOrCreateSourceFile(input.absPath, input.content)

  const mod = await loadExtractorModule(input.extractorModule)
  const fn = mod[input.extractorExport]
  if (typeof fn !== 'function') {
    throw new Error(`Worker extractor "${input.extractorExport}" is not a function`)
  }

  const result = input.extractorOptions !== undefined
    ? (fn as (...a: unknown[]) => unknown)(sf, input.relPath, input.extractorOptions)
    : (fn as (...a: unknown[]) => unknown)(sf, input.relPath)

  return result
}

// ─── Phase γ.3b — Batch dispatch ────────────────────────────────────────────

interface BatchDetectorSpec {
  /** Clé unique pour le fanout main-thread. */
  key: string
  extractorModule: string
  extractorExport: string
  extractorOptions?: unknown
}

interface BatchInput {
  absPath: string
  content: string
  relPath: string
  detectors: BatchDetectorSpec[]
}

interface BatchOutput {
  /** Map de detector key → résultat brut (Item[] typiquement). */
  results: Record<string, unknown>
}

/**
 * Phase γ.3b — Worker batch entrypoint. Parse le fichier UNE fois, exécute
 * tous les détecteurs sur le même SourceFile, retourne map { key → Item[] }.
 *
 * Cuts dispatches × N (N = nb détecteurs) → 1 IPC + 1 parse au lieu de
 * N × IPC + N × parse (au pire) ou N × IPC + 1 parse (avec affinity LRU).
 *
 * Le main thread fan-out via runBatchedSourceFileDetectors dans
 * per-source-file-extractor.ts.
 */
export async function extractBatchInWorker(input: BatchInput): Promise<BatchOutput> {
  const sf = getOrCreateSourceFile(input.absPath, input.content)

  // Charge en parallèle tous les modules détecteurs (cache cross-tasks).
  const mods = await Promise.all(
    input.detectors.map((d) => loadExtractorModule(d.extractorModule)),
  )

  const results: Record<string, unknown> = {}
  for (let i = 0; i < input.detectors.length; i++) {
    const d = input.detectors[i]
    const fn = mods[i][d.extractorExport]
    if (typeof fn !== 'function') {
      throw new Error(`Worker batch extractor "${d.extractorExport}" is not a function`)
    }
    results[d.key] = d.extractorOptions !== undefined
      ? (fn as (...a: unknown[]) => unknown)(sf, input.relPath, d.extractorOptions)
      : (fn as (...a: unknown[]) => unknown)(sf, input.relPath)
  }
  return { results }
}

/**
 * Hook test/observabilité — exposé pour vérifier le hit rate du cache LRU
 * dans les benchmarks. Pas appelé en prod.
 */
export function _cacheStatsForTest(): { size: number; cap: number } {
  return { size: sourceFileCache.size, cap: MAX_CACHE_ENTRIES }
}
