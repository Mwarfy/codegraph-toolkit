// ADR-024
/**
 * Cost model auto-tuning — décide per-detector si worker mode vaut le coût.
 *
 * Décision binaire (Phase γ.1) : worker ou main thread ? Basée sur la
 * data runtime existante (DetectorTiming.facts si dispo) ou heuristiques
 * statiques.
 *
 * Trade-off worker_threads :
 *   - Coût par task : ~50-200μs postMessage + structuredClone
 *   - Coût pool init : ~30-100ms one-shot (amortisable global pool)
 *   - Gain : × N cores sur CPU-bound tasks > 5ms
 *
 * Heuristique de décision (LIBY_BSP_WORKERS=auto) :
 *
 *   if mean_task_ms < 5ms        → main thread (overhead > gain)
 *   if total_ms < 100ms          → main thread (pas la peine de spawn pool)
 *   if file_count < 50           → main thread (overhead × N pas amortisable)
 *   else                         → worker mode
 *
 * Sources de la data :
 *   1. .codegraph/facts-self-runtime/DetectorTiming.facts (si probe a tourné)
 *   2. Sinon : default conservatif (main thread sauf indication contraire)
 *
 * Mode override :
 *   LIBY_BSP_WORKERS=1     → force worker pour tous les détecteurs portés
 *   LIBY_BSP_WORKERS=0     → force main thread (debug / déterminisme exact)
 *   LIBY_BSP_WORKERS=auto  → cost model décide per-detector (default futur)
 *   LIBY_BSP_WORKERS unset → main thread (compat default actuel)
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export interface CostModelOptions {
  /** Path racine du projet — pour trouver .codegraph/facts-self-runtime/. */
  projectRoot: string
  /** Nombre de fichiers à traiter — input du modèle. */
  fileCount: number
}

export type WorkerDecision = 'workers' | 'main-thread'

interface DetectorTimingRow {
  detector: string
  meanMs: number
  p95Ms: number
  totalRuntimeMs: number
}

const MIN_MEAN_MS_FOR_WORKERS = 5
const MIN_TOTAL_MS_FOR_WORKERS = 100
const MIN_FILE_COUNT_FOR_WORKERS = 50

/**
 * Décide globalement (tous détecteurs confondus) : worker ou main thread.
 *
 * Lit la dernière mesure DetectorTiming si dispo. Sinon retourne main-thread
 * par sécurité (Phase γ.1 — Phase γ.2 fera per-detector).
 */
export async function decideWorkerMode(opts: CostModelOptions): Promise<WorkerDecision> {
  const explicit = readExplicitOverride()
  if (explicit !== null) return explicit

  if (opts.fileCount < MIN_FILE_COUNT_FOR_WORKERS) {
    return 'main-thread'
  }

  const timings = await loadDetectorTimings(opts.projectRoot)
  if (timings.length === 0) {
    // Pas de data runtime — on default main-thread (conservatif)
    return 'main-thread'
  }

  // Total time agrégé sur les détecteurs portés (per-file pattern)
  const total = timings.reduce((s, t) => s + t.totalRuntimeMs, 0)
  const meanPerCall = timings.reduce((s, t) => s + t.meanMs, 0) / timings.length

  if (total < MIN_TOTAL_MS_FOR_WORKERS) return 'main-thread'
  if (meanPerCall < MIN_MEAN_MS_FOR_WORKERS) return 'main-thread'

  return 'workers'
}

function readExplicitOverride(): WorkerDecision | null {
  const env = process.env.LIBY_BSP_WORKERS
  if (env === '1') return 'workers'
  if (env === '0') return 'main-thread'
  // 'auto' explicit → continue avec heuristiques. Tout le reste (unset
  // inclus) → main-thread default. Conservatif : worker mode requires
  // explicit opt-in pour éviter de casser tests/CI qui chargent depuis src.
  if (env === 'auto') return null
  return 'main-thread'
}

async function loadDetectorTimings(projectRoot: string): Promise<DetectorTimingRow[]> {
  const factsFile = path.join(projectRoot, '.codegraph/facts-self-runtime/DetectorTiming.facts')
  try {
    const text = await fs.readFile(factsFile, 'utf-8')
    return parseDetectorTimings(text)
  } catch {
    return []
  }
}

function parseDetectorTimings(text: string): DetectorTimingRow[] {
  const out: DetectorTimingRow[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const cols = line.split('\t')
    // Format : detector  runs  meanMs  p95Ms  stdDevX1000  lambdaX1000
    if (cols.length < 6) continue
    const meanMs = parseFloat(cols[2])
    const p95Ms = parseFloat(cols[3])
    const runs = parseFloat(cols[1])
    if (!Number.isFinite(meanMs) || !Number.isFinite(p95Ms)) continue
    out.push({
      detector: cols[0],
      meanMs,
      p95Ms,
      totalRuntimeMs: meanMs * runs,
    })
  }
  return out
}
