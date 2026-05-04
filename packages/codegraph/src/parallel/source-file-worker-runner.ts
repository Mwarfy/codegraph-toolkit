// ADR-024
/**
 * Worker entrypoint générique pour les détecteurs Project ts-morph
 * (Phase γ.2 BSP).
 *
 * Reçoit { absPath, content, relPath, extractorModule, extractorExport,
 *          extractorOptions? } via parallelMapWorkers. Crée un mini-Project
 * ts-morph local au worker (1 SourceFile), appelle l'extractor pure,
 * retourne items.
 *
 * Limites par design :
 *   - Le mini-Project ne contient QUE le file traité. Pas de résolution
 *     cross-file (imports, type checking sur d'autres modules) → exclu pour
 *     les détecteurs comme ts-imports, qui restent main-thread.
 *   - Convient aux détecteurs PUREMENT per-file (logique AST locale) :
 *     function-complexity, long-functions, dead-code, magic-numbers,
 *     hardcoded-secrets, sanitizers, taint-sinks, eval-calls, crypto-algo,
 *     etc. La majorité.
 *
 * Coût : ~10-30ms parse per file (vs cache hit shared Project main thread).
 * Gain attendu : N cores × parse_time. Crossover ROI ~50 fichiers × ~20ms.
 *
 * Usage :
 *   parallelMapWorkers({
 *     items: tsFiles.map(f => ({ absPath, content, relPath })),
 *     workerModule: '<path>/source-file-worker-runner.js',
 *     workerExport: 'extractInWorker',
 *     monoid: appendSortedMonoid(...),
 *   })
 */

import { Project } from 'ts-morph'
import { pathToFileURL } from 'node:url'

const projectCache = new Map<string, Project>()  // unused for now, future cache
void projectCache

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

/**
 * Worker fn appelée par worker-runner.ts via dynamic dispatch.
 *
 * Retourne le résultat brut de l'extractor (Bundle ou Item[]) — le caller
 * fait selectItems main thread.
 */
export async function extractInWorker(input: WorkerInput): Promise<unknown> {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true, resolveJsonModule: true },
  })
  const sf = project.createSourceFile(input.absPath, input.content, { overwrite: true })

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
