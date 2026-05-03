/**
 * Self-runtime regression gate — math invariant qui PETE si une
 * détérioration runtime est introduite SANS Salsa-isation.
 *
 * Pourquoi ce test existe :
 *   Après les optims Salsa (commit afd0965 + suite), 4 détecteurs sont
 *   passés de λ_lyap ≈ 1 (no cache) → λ_lyap > 15 (cache cliff). Toute
 *   nouvelle régression — fichier devenu hot ET non-cached — doit être
 *   détectée AUTOMATIQUEMENT au prochain run de tests, pas découverte
 *   par tâtonnement.
 *
 * Méthode :
 *   1. Run analyze() en mode WARM 3 fois (cache populated).
 *   2. Pour chaque détecteur, calcule λ_lyap = log(p95+1)/log(median+1).
 *   3. Si un détecteur a mean ≥ 200ms ET λ ≤ 1.10 → FAIL avec message
 *      qui pointe le détecteur + recommande la Salsa-isation.
 *
 * Bornes math défendables :
 *   - mean ≥ 200ms : détecteur "hot enough" pour mériter caching.
 *   - λ ≤ 1.10 : cold path ≈ warm path → preuve d'absence de cache.
 *   - Sur le toolkit T4 : 0 violations (tous les hot detectors cachés).
 *
 * Coût : ~6s (3 runs × ~2s warm). Run uniquement quand analyzer.ts ou
 * incremental/* changent (futur : conditional test via testTags).
 *
 * Exclusions :
 *   - Cold runs ne comptent pas — la 1e itération populate le cache.
 *   - Le test PETE seulement si le DESIGN a régressé (nouveau hot path
 *     non-cached), pas si l'environnement est lent ce jour-là.
 */

import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze } from '../src/core/analyzer.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../../..')

const HOT_THRESHOLD_MS = 200
const NO_CACHE_LAMBDA_MAX = 1.10
const N_RUNS = 3

/**
 * Exemptions documentées : détecteurs dont le pattern n'est PAS per-file
 * (donc le pattern Salsa per-fileContent ne s'applique pas).
 * Chaque entrée doit avoir une raison claire.
 */
const EXEMPT_DETECTORS = new Map<string, string>([
  [
    'persistent-cycles',
    'Reads .codegraph/snapshot-*.json history (cross-snapshot temporal). ' +
      'Pas de per-file caching applicable — invalidation = "new snapshot ' +
      'created". Designed cost: ~300ms par run.',
  ],
])

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

interface DetectorStats {
  name: string
  mean: number
  median: number
  p95: number
  lambda: number
}

async function runStats(): Promise<DetectorStats[]> {
  const detectorTimings = new Map<string, number[]>()
  for (let i = 0; i < N_RUNS; i++) {
    const result = await analyze(
      {
        rootDir: REPO_ROOT,
        include: ['packages/**/*.ts'],
        exclude: [
          '**/node_modules/**',
          '**/dist/**',
          '**/tests/fixtures/**',
        ],
      },
      {
        skipPersistenceLoad: false,
        skipPersistenceSave: false,
        incremental: true,
      },
    )
    for (const [name, ms] of Object.entries(result.timing.detectors)) {
      if (!detectorTimings.has(name)) detectorTimings.set(name, [])
      detectorTimings.get(name)!.push(ms)
    }
  }

  // Skip first run (cold-warm cache populating)
  const stats: DetectorStats[] = []
  for (const [name, samples] of detectorTimings) {
    const warmSamples = samples.slice(1) // drop run 0 (cold)
    if (warmSamples.length === 0) continue
    const mean = warmSamples.reduce((s, x) => s + x, 0) / warmSamples.length
    const median = percentile(warmSamples, 0.5)
    const p95 = percentile(warmSamples, 0.95)
    const lambda = median > 0 ? Math.log(p95 + 1) / Math.log(median + 1) : 0
    stats.push({ name, mean, median, p95, lambda })
  }
  return stats
}

describe('self-runtime regression gate (math invariant on Lyapunov-like λ)', () => {
  it(
    'no detector should have mean ≥ 200ms AND λ_lyap ≤ 1.10 (warm)',
    { timeout: 60_000 },
    async () => {
      const stats = await runStats()
      const violations = stats.filter(
        (s) =>
          s.mean >= HOT_THRESHOLD_MS &&
          s.lambda <= NO_CACHE_LAMBDA_MAX &&
          !EXEMPT_DETECTORS.has(s.name),
      )

      if (violations.length > 0) {
        const msg = violations
          .map(
            (v) =>
              `  - ${v.name}: mean=${v.mean.toFixed(0)}ms median=${v.median.toFixed(0)}ms ` +
              `p95=${v.p95.toFixed(0)}ms λ=${v.lambda.toFixed(2)}`,
          )
          .join('\n')
        throw new Error(
          `Found ${violations.length} hot detector(s) without effective caching:\n${msg}\n\n` +
            'These detectors are hot (mean ≥ 200ms warm) but their λ_lyap ≈ 1 ' +
            '(p95 ≈ median) means they do NOT benefit from cache. Salsa-isolate ' +
            'them via packages/codegraph/src/incremental/<name>.ts following ' +
            'the ADR-007 pattern.',
        )
      }
    },
  )
})
