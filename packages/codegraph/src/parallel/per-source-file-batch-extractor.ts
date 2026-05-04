// ADR-024
/**
 * Phase γ.3b — Batch dispatch pour les détecteurs Project ts-morph.
 *
 * Au lieu de N analyzeXxx() calls séquentiels qui dispatchent chacun N×files
 * tasks (= N × files dispatches au total), on agrège tous les détecteurs en
 * UN seul batch :
 *   - 1 dispatch par fichier
 *   - Le worker parse 1 fois, exécute les N détecteurs sur le même SourceFile
 *   - Retourne map { detectorKey → Item[] }
 *   - Main thread fan-out vers les monoïdes per-detector pour fold canonique
 *
 * Réduction : N×files → files dispatches. Sur 11 détecteurs × 175 files,
 * on passe de 1925 IPC roundtrips à 175 (×11 saved). Le serialization
 * overhead du content (5KB × 11 par file) devient × 1.
 *
 * Garanties préservées :
 *   - Déterminisme : chaque detector a son sortKey, le fold reste stable lex
 *   - Pure fns : worker batch reste read-only sur SourceFile
 *   - Bit-identique : les mêmes extractor functions sont appelées, juste
 *     groupées dans un message.
 */

import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import type { Project, SourceFile } from 'ts-morph'
import { getGlobalPool } from './worker-pool.js'

export interface BatchDetectorConfig<Item> {
  /** Clé unique cross-detector pour le fanout. */
  key: string
  /** Path absolu vers le compiled .js qui exporte la worker fn. */
  workerModule: string
  /** Nom de la fn exportée — signature `(sf, relPath, options?) => Item[]`. */
  workerExport: string
  /** 3e arg optionnel passé à la fn cross-thread. */
  workerExtractorOptions?: unknown
  /** Sort key canonique pour ce détecteur. */
  sortKey: (item: Item) => string
  /**
   * Fallback main-thread (optionnel) — utilisé seulement par
   * runBatchedSourceFileDetectorsMainThread. Le caller qui ne va que
   * vers les workers peut omettre.
   */
  mainThreadExtractor?: (sf: SourceFile, relPath: string) => Item[]
  /** Skip this detector for files matching predicate. */
  skipFile?: (relPath: string) => boolean
}

export interface PerSourceFileBatchOptions {
  project: Project
  files: string[]
  rootDir: string
  /** Liste des détecteurs à exécuter en batch sur chaque file. */
  detectors: ReadonlyArray<BatchDetectorConfig<unknown>>
}

export type BatchResults = Record<string, unknown[]>

function resolveBatchRunnerPath(): string {
  const env = process.env.LIBY_BSP_SOURCE_FILE_RUNNER
  if (env) return env
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.join(here, 'source-file-worker-runner.js')
}

interface WorkerBatchOutput {
  results: Record<string, unknown>
}

/**
 * Worker mode (batch). Le caller décide d'activer cette voie via cost-model.
 * Retourne map { key → Item[] sortés canoniquement }.
 */
export async function runBatchedSourceFileDetectorsViaWorkers(
  opts: PerSourceFileBatchOptions,
): Promise<BatchResults> {
  const fileSet = new Set(opts.files)
  const pool = getGlobalPool()
  const runnerPath = resolveBatchRunnerPath()

  const sourceFiles: Array<{ sf: SourceFile; rel: string; abs: string }> = []
  for (const sf of opts.project.getSourceFiles()) {
    const abs = sf.getFilePath()
    const rel = relativize(abs, opts.rootDir)
    if (!rel || !fileSet.has(rel)) continue
    sourceFiles.push({ sf, rel, abs })
  }

  // Pré-init buckets pour ordre stable.
  const accumulator: Record<string, unknown[][]> = {}
  for (const d of opts.detectors) accumulator[d.key] = []

  // Dispatch 1 task par file. Chaque task = batch de N détecteurs.
  await Promise.all(
    sourceFiles.map(async ({ sf, rel, abs }) => {
      const detectorList = opts.detectors
        .filter((d) => !d.skipFile || !d.skipFile(rel))
        .map((d) => ({
          key: d.key,
          extractorModule: d.workerModule,
          extractorExport: d.workerExport,
          extractorOptions: d.workerExtractorOptions,
        }))
      if (detectorList.length === 0) return
      const input = {
        absPath: abs,
        content: sf.getFullText(),
        relPath: rel,
        detectors: detectorList,
      }
      const out = await pool.dispatch<WorkerBatchOutput>(
        runnerPath,
        'extractBatchInWorker',
        [input],
        abs,  // affinity key — même file → même worker → cache LRU hit
      )
      // Push per-key per-file. Ordre lex restauré via sort post-fold.
      for (const [k, v] of Object.entries(out.results)) {
        if (!Array.isArray(v)) continue
        accumulator[k]?.push(v)
      }
    }),
  )

  // Flatten + sort canonique per-detector.
  const final: BatchResults = {}
  for (const d of opts.detectors) {
    const flat: unknown[] = []
    for (const slice of accumulator[d.key] ?? []) flat.push(...slice)
    const sortFn = d.sortKey as (item: unknown) => string
    flat.sort((a, b) => {
      const ka = sortFn(a)
      const kb = sortFn(b)
      return ka < kb ? -1 : ka > kb ? 1 : 0
    })
    final[d.key] = flat
  }
  return final
}

/**
 * Fallback main-thread : exécute les détecteurs en série, parse partagé via
 * le Project ts-morph existant. Pas de gain × N cores ici, mais 0 IPC.
 */
export async function runBatchedSourceFileDetectorsMainThread(
  opts: PerSourceFileBatchOptions,
): Promise<BatchResults> {
  const fileSet = new Set(opts.files)
  const accumulator: Record<string, unknown[]> = {}
  for (const d of opts.detectors) accumulator[d.key] = []

  for (const sf of opts.project.getSourceFiles()) {
    const abs = sf.getFilePath()
    const rel = relativize(abs, opts.rootDir)
    if (!rel || !fileSet.has(rel)) continue
    for (const d of opts.detectors) {
      if (d.skipFile && d.skipFile(rel)) continue
      if (!d.mainThreadExtractor) continue  // skip si pas de fallback fourni
      const items = d.mainThreadExtractor(sf, rel)
      ;(accumulator[d.key] as unknown[]).push(...items)
    }
  }

  for (const d of opts.detectors) {
    const arr = accumulator[d.key] as unknown[]
    const sortFn = d.sortKey as (item: unknown) => string
    arr.sort((a, b) => {
      const ka = sortFn(a)
      const kb = sortFn(b)
      return ka < kb ? -1 : ka > kb ? 1 : 0
    })
  }
  return accumulator
}

function relativize(absPath: string, rootDir: string): string | null {
  const normalized = absPath.replace(/\\/g, '/')
  const rootNormalized = rootDir.replace(/\\/g, '/')
  if (!normalized.startsWith(rootNormalized)) return null
  return normalized.slice(rootNormalized.length + 1)
}
