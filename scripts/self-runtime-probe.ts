/**
 * Self-runtime probe — exécute `codegraph analyze` N fois et capture les
 * timings par détecteur, puis émet des facts datalog `DetectorTiming` que
 * les rules d'auto-optimisation peuvent join avec les facts statiques
 * (IB, dependency-coupling, etc.) pour ranker les candidats à l'optim.
 *
 * Pourquoi pas OTel auto-instrument :
 *   L'analyzer ne fait pas d'I/O HTTP/DB — auto-instrument capture rien
 *   d'utile. Les timings que NOUS voulons sont au niveau detector (ex:
 *   "deprecated-usage prend 834ms"), déjà disponibles dans
 *   `analyze.result.timing.detectors`. On les transforme en facts.
 *
 * Discipline mathématique appliquée :
 *   - Sur N runs, on calcule pour chaque detector :
 *     - mean (μ) : latence moyenne
 *     - p95     : tail latency
 *     - stdDev (σ) : variance
 *     - λ_lyap (proxy)= log(p95+1) / log(median+1) — instabilité relative
 *   - Sur N=5 ou plus → confidence réelle dans les bornes.
 *
 * Output : .codegraph/facts-self-runtime/DetectorTiming.facts
 *   schema : (detector, runs, meanMs, p95Ms, stdDevX1000, lambdaX1000)
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze } from '../packages/codegraph/src/core/analyzer.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const FACTS_OUT = path.join(REPO_ROOT, '.codegraph/facts-self-runtime')

const N_RUNS = parseInt(process.env.LIBY_PROBE_RUNS ?? '3', 10)

interface DetectorStats {
  name: string
  runs: number
  mean: number
  p95: number
  median: number
  stdDev: number
  lambda: number
  samples: number[]
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p))
  return sorted[idx]
}

function statsOf(name: string, samples: number[]): DetectorStats {
  const n = samples.length
  const mean = samples.reduce((s, x) => s + x, 0) / n
  const median = percentile(samples, 0.5)
  const p95 = percentile(samples, 0.95)
  const variance = samples.reduce((s, x) => s + (x - mean) ** 2, 0) / n
  const stdDev = Math.sqrt(variance)
  // Proxy Lyapunov : λ = log(p95+1) / log(median+1) — instabilité relative.
  // Si p95 ~ median (stable) → λ ≈ 1. Si p95 >> median (cliffs) → λ >> 1.
  const lambda = median > 0 ? Math.log(p95 + 1) / Math.log(median + 1) : 0
  return { name, runs: n, mean, p95, median, stdDev, lambda, samples }
}

async function main(): Promise<void> {
  console.log(`[self-runtime-probe] ${N_RUNS} runs of codegraph analyze...`)
  const detectorTimings: Map<string, number[]> = new Map()
  const totalTimings: number[] = []

  // WARM mode : load persisted Salsa cache between runs (default for prod
  // usage). Set LIBY_PROBE_COLD=1 to force cold runs (no cache reuse).
  const cold = process.env.LIBY_PROBE_COLD === '1'
  console.log(`[self-runtime-probe] mode: ${cold ? 'COLD (no cache)' : 'WARM (Salsa cache)'}`)

  for (let run = 0; run < N_RUNS; run++) {
    const t0 = Date.now()
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
        skipPersistenceLoad: cold,
        skipPersistenceSave: cold,
        incremental: !cold,
      },
    )
    const dt = Date.now() - t0
    totalTimings.push(dt)
    for (const [name, ms] of Object.entries(result.timing.detectors)) {
      if (!detectorTimings.has(name)) detectorTimings.set(name, [])
      detectorTimings.get(name)!.push(ms)
    }
    console.log(
      `  run ${run + 1}/${N_RUNS}: ${dt}ms ` +
        `(${result.snapshot.nodes.length} nodes, ${result.snapshot.edges.length} edges)`,
    )
  }

  // Compute stats per detector
  const stats: DetectorStats[] = []
  for (const [name, samples] of detectorTimings) {
    stats.push(statsOf(name, samples))
  }
  stats.sort((a, b) => b.p95 - a.p95)

  console.log('\n[self-runtime-probe] top 10 detectors by p95 latency:')
  console.log(
    '  detector'.padEnd(36) +
      'mean'.padStart(8) +
      'median'.padStart(8) +
      'p95'.padStart(8) +
      'σ'.padStart(7) +
      'λ_lyap'.padStart(8),
  )
  for (const s of stats.slice(0, 10)) {
    console.log(
      `  ${s.name.padEnd(34)}` +
        `${s.mean.toFixed(0).padStart(8)}` +
        `${s.median.toFixed(0).padStart(8)}` +
        `${s.p95.toFixed(0).padStart(8)}` +
        `${s.stdDev.toFixed(0).padStart(7)}` +
        `${s.lambda.toFixed(2).padStart(8)}`,
    )
  }

  // Total stats
  const totalStats = statsOf('TOTAL_ANALYZE', totalTimings)
  console.log(
    `\n[self-runtime-probe] total : mean=${totalStats.mean.toFixed(0)}ms ` +
      `median=${totalStats.median.toFixed(0)}ms p95=${totalStats.p95.toFixed(0)}ms ` +
      `λ=${totalStats.lambda.toFixed(2)}`,
  )

  // Write facts
  await fs.mkdir(FACTS_OUT, { recursive: true })

  // Archive l'ancien DetectorTiming.facts → baseline/ AVANT d'écrire le
  // nouveau. Permet à scripts/runtime-diff.ts (post-commit hook) de comparer
  // chaque commit contre la dernière mesure réelle (rafraîchie quand l'humain
  // re-run le probe). Best-effort — pas de baseline initial = skip diff.
  const factsFile = path.join(FACTS_OUT, 'DetectorTiming.facts')
  const baselineDir = path.join(FACTS_OUT, 'baseline')
  try {
    await fs.access(factsFile)
    await fs.mkdir(baselineDir, { recursive: true })
    await fs.copyFile(factsFile, path.join(baselineDir, 'DetectorTiming.facts'))
  } catch {
    // pas de fichier existant — premier run, pas d'archive
  }

  // DetectorTiming(detector, runs, meanMs, p95Ms, stdDevX1000, lambdaX1000)
  const lines: string[] = []
  for (const s of stats) {
    lines.push([
      s.name,
      String(s.runs),
      String(Math.round(s.mean)),
      String(Math.round(s.p95)),
      String(Math.round(s.stdDev * 1000)),
      String(Math.round(s.lambda * 1000)),
    ].join('\t'))
  }
  lines.sort()
  await fs.writeFile(factsFile, lines.join('\n') + '\n')

  // Schema
  const schema = [
    '// Auto-generated by scripts/self-runtime-probe.ts — DO NOT EDIT',
    '.decl DetectorTiming(detector:symbol, runs:number, meanMs:number, p95Ms:number, stdDevX1000:number, lambdaX1000:number)',
    '.input DetectorTiming',
    '',
  ].join('\n')
  await fs.writeFile(path.join(FACTS_OUT, 'schema-self-runtime.dl'), schema)

  console.log(
    `\n[self-runtime-probe] wrote ${lines.length} DetectorTiming facts to ${path.relative(REPO_ROOT, FACTS_OUT)}`,
  )
}

main().catch((err) => {
  console.error('[self-runtime-probe] fatal:', err)
  process.exit(1)
})
