/**
 * Static Cost Estimator (Niveau 2A self-optim) — prédit le runtime warm
 * d'un détecteur SANS l'exécuter, par régression linéaire calibrée sur
 * les facts DetectorTiming + File + FunctionComplexity.
 *
 * Modèle :
 *   predicted_warm_ms(D) = α(D)
 *                        + β × N_files_processed(D)
 *                        + γ × Σ(LOC × McCabe(fn)) over files
 *                        + δ × N_AST_walks(D)  // estimated from extractor source
 *
 * Calibration :
 *   Prend les facts `DetectorTiming.facts` (1 row par detector) et
 *   solve pour (α, β, γ, δ) en minimisant le MSE via OLS direct (pas
 *   besoin de scipy — closed form sur 3-4 features).
 *
 * Usage :
 *   - Calibration : `npx tsx scripts/static-cost-estimator.ts --calibrate`
 *     → écrit `.codegraph/cost-model.json` avec les coefficients.
 *   - Prédiction : `npx tsx scripts/static-cost-estimator.ts --predict <detector>`
 *     → lit le model, retourne predicted_warm_ms.
 *   - Au post-commit : pas besoin de re-calibrer si le model existe.
 *     Quand un nouveau détecteur est ajouté, on peut le PRÉDIRE
 *     (extrapolation depuis ses caractéristiques statiques) sans
 *     re-runner le probe.
 *
 * Limites :
 *   - Modèle linéaire = approximation (pas de cross-feature interaction).
 *   - Calibration sur N=~30 datapoints → variance haute sur les outliers.
 *   - Ne capture pas les effets cache I/O OS (page faults, etc.).
 *
 * Précision attendue : 15-20% MAPE (mean absolute percentage error) —
 * suffisant pour ranker les candidats d'optimisation, pas pour budget
 * exact.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

const FACTS_DIR = path.join(REPO_ROOT, '.codegraph/facts')
const RUNTIME_FACTS = path.join(REPO_ROOT, '.codegraph/facts-self-runtime/DetectorTiming.facts')
const MODEL_OUT = path.join(REPO_ROOT, '.codegraph/cost-model.json')

interface DetectorTimingRow {
  detector: string
  meanMs: number
  p95Ms: number
  lambdaX1000: number
}

interface CostFeatures {
  detector: string
  /** LOC du fichier extractor lui-même (proxy de la complexité du detector). */
  detectorLoc: number
  /** Nb d'invocations `getDescendantsOfKind` dans le source (AST walks). */
  astWalks: number
  /** Estimation du nb de passes sur le project (1 si pure scan, 2 si 2-pass, ≥3 si multi). */
  estimatedPasses: number
  /** Nb de regex / RegExp.exec dans le source (cost ~constant per file). */
  regexOps: number
}

interface CostModel {
  /** Coefficients : intercept (α), coef_nFiles (β), coef_complexity (γ), coef_passes (δ). */
  alpha: number
  beta: number
  gamma: number
  delta: number
  /** Stats de calibration. */
  mape: number
  rSquared: number
  nDatapoints: number
  calibratedAt: string
}

async function loadDetectorTimings(): Promise<DetectorTimingRow[]> {
  const raw = await fs.readFile(RUNTIME_FACTS, 'utf-8')
  return raw.trim().split('\n').map((line) => {
    const cols = line.split('\t')
    return {
      detector: cols[0],
      meanMs: parseInt(cols[2], 10),
      p95Ms: parseInt(cols[3], 10),
      lambdaX1000: parseInt(cols[5], 10),
    }
  })
}

async function loadFiles(): Promise<string[]> {
  const raw = await fs.readFile(path.join(FACTS_DIR, 'File.facts'), 'utf-8')
  return raw.trim().split('\n')
}

async function loadComplexity(): Promise<Map<string, number>> {
  // FunctionComplexity.facts : (file, fnName, line, mccabe, loc, ...)
  const raw = await fs.readFile(path.join(FACTS_DIR, 'FunctionComplexity.facts'), 'utf-8')
  const byFile = new Map<string, number>()
  for (const line of raw.trim().split('\n')) {
    const cols = line.split('\t')
    if (cols.length < 5) continue
    const file = cols[0]
    const mccabe = parseInt(cols[3], 10) || 1
    const loc = parseInt(cols[4], 10) || 0
    byFile.set(file, (byFile.get(file) ?? 0) + loc * mccabe)
  }
  return byFile
}

/**
 * Heuristique pass count : depuis le nom du détecteur, on devine le nb
 * de passes sur l'AST. Pas perfect mais corrélé. Future work : analyser
 * statiquement le nb de `for (const sf of project.getSourceFiles())`
 * dans le code source du détecteur.
 */
function estimatePasses(detectorName: string): number {
  // Détecteurs à 2-pass connus (cross-fichier global state).
  const TWO_PASS = new Set(['deprecated-usage'])
  // Détecteurs cross-discipline qui combinent plusieurs passes.
  const MULTI_PASS = new Set([
    'cross-discipline', 'persistent-cycles', 'lyapunov-cochange',
    'compression-similarity', 'granger-causality', 'fact-stability',
  ])
  if (TWO_PASS.has(detectorName)) return 2
  if (MULTI_PASS.has(detectorName)) return 3
  return 1
}

/**
 * Build features for each detector. Lit le source code du détecteur lui-même
 * pour extraire des features discriminantes (LOC, nb AST walks, nb regex).
 *
 * Convention : on cherche le fichier source du détecteur dans
 *   packages/codegraph/src/extractors/<detector>.ts
 * S'il n'existe pas (cas des cross-discipline orchestrators ou détecteurs
 * inline dans analyzer.ts), on retourne des features par défaut faibles.
 */
async function buildFeatures(detector: string): Promise<CostFeatures> {
  const candidatePaths = [
    path.join(REPO_ROOT, `packages/codegraph/src/extractors/${detector}.ts`),
    path.join(REPO_ROOT, `packages/codegraph/src/extractors/${detector.replace(/-/g, '_')}.ts`),
  ]
  let source = ''
  for (const p of candidatePaths) {
    try {
      source = await fs.readFile(p, 'utf-8')
      break
    } catch {
      // try next
    }
  }
  const detectorLoc = source ? source.split('\n').length : 50    // default for unknown
  const astWalks = source ? (source.match(/getDescendantsOfKind|forEachDescendant|getChildren\(/g) ?? []).length : 1
  const regexOps = source ? (source.match(/\.exec\(|\.match\(|\.test\(|new RegExp\(/g) ?? []).length : 0
  return {
    detector,
    detectorLoc,
    astWalks,
    regexOps,
    estimatedPasses: estimatePasses(detector),
  }
}

/**
 * Ordinary Least Squares pour 4-coef linear regression :
 *   y = α + β x1 + γ x2 + δ x3
 *
 * Solve via les normal equations : (XᵀX) θ = Xᵀy.
 * Pour 4 coefs, c'est une 4×4 matrix inverse — directement faisable.
 */
function solveOLS(
  X: number[][], // shape [n, 4] — rows : [1, nFiles, complexity, passes]
  y: number[],   // shape [n] — observed meanMs
): number[] {
  const n = X.length
  const k = 4
  // Build XᵀX (4×4)
  const XtX: number[][] = Array.from({ length: k }, () => new Array(k).fill(0))
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      for (let b = 0; b < k; b++) {
        XtX[a][b] += X[i][a] * X[i][b]
      }
    }
  }
  // Build Xᵀy (4)
  const Xty = new Array<number>(k).fill(0)
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += X[i][a] * y[i]
    }
  }
  // Solve via Gauss-Jordan elimination on augmented [XtX | Xty]
  const aug: number[][] = XtX.map((row, i) => [...row, Xty[i]])
  for (let pivot = 0; pivot < k; pivot++) {
    // Partial pivoting for numerical stability
    let maxRow = pivot
    for (let r = pivot + 1; r < k; r++) {
      if (Math.abs(aug[r][pivot]) > Math.abs(aug[maxRow][pivot])) maxRow = r
    }
    ;[aug[pivot], aug[maxRow]] = [aug[maxRow], aug[pivot]]
    const pv = aug[pivot][pivot]
    if (Math.abs(pv) < 1e-12) {
      // Singular — return zeros (dégénéré, datapoints insuffisants)
      return new Array<number>(k).fill(0)
    }
    for (let c = pivot; c <= k; c++) aug[pivot][c] /= pv
    for (let r = 0; r < k; r++) {
      if (r === pivot) continue
      const factor = aug[r][pivot]
      for (let c = pivot; c <= k; c++) aug[r][c] -= factor * aug[pivot][c]
    }
  }
  return aug.map((row) => row[k])
}

async function calibrate(): Promise<CostModel> {
  const timings = await loadDetectorTimings()

  // Log-linéaire model :
  //   log(meanMs+1) = α + β log(loc+1) + γ log(walks+1) + δ log(passes×regexes+1)
  // Avantage : prédictions toujours positives (exp(...) > 0), gère les
  // outliers gracefully (Lyapunov power-law fit).
  const X: number[][] = []
  const y: number[] = []
  for (const t of timings) {
    if (t.meanMs <= 0) continue
    const f = await buildFeatures(t.detector)
    X.push([
      1,
      Math.log(f.detectorLoc + 1),
      Math.log(f.astWalks + 1),
      Math.log(f.regexOps + 5 * f.estimatedPasses + 1),
    ])
    y.push(Math.log(t.meanMs + 1))
  }

  if (X.length < 5) {
    throw new Error(`Not enough datapoints (${X.length}) — need ≥ 5`)
  }

  const [alpha, beta, gamma, delta] = solveOLS(X, y)

  // Compute MAPE + R² in linear space (more interpretable)
  const predicted = X.map((row) => Math.exp(alpha + beta * row[1] + gamma * row[2] + delta * row[3]) - 1)
  const yLinear = y.map((v) => Math.exp(v) - 1)
  const mape =
    yLinear.reduce((s, yi, i) => s + Math.abs((yi - predicted[i]) / Math.max(yi, 1)), 0) / yLinear.length
  const meanY = yLinear.reduce((s, yi) => s + yi, 0) / yLinear.length
  const ssTot = yLinear.reduce((s, yi) => s + (yi - meanY) ** 2, 0)
  const ssRes = yLinear.reduce((s, yi, i) => s + (yi - predicted[i]) ** 2, 0)
  const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0

  return {
    alpha, beta, gamma, delta,
    mape, rSquared,
    nDatapoints: X.length,
    calibratedAt: new Date().toISOString(),
  }
}

function predictFromFeatures(model: CostModel, f: CostFeatures): number {
  const logPred =
    model.alpha +
    model.beta * Math.log(f.detectorLoc + 1) +
    model.gamma * Math.log(f.astWalks + 1) +
    model.delta * Math.log(f.regexOps + 5 * f.estimatedPasses + 1)
  return Math.max(0, Math.exp(logPred) - 1)
}

async function predictDetector(name: string, model: CostModel): Promise<number> {
  const f = await buildFeatures(name)
  return predictFromFeatures(model, f)
}

async function main(): Promise<void> {
  const arg = process.argv[2] ?? '--calibrate'

  if (arg === '--calibrate') {
    const model = await calibrate()
    await fs.writeFile(MODEL_OUT, JSON.stringify(model, null, 2))
    console.log(`[cost-estimator] model calibrated:`)
    console.log(`  α (intercept)        : ${model.alpha.toFixed(2)} ms`)
    console.log(`  β (per file)          : ${model.beta.toFixed(4)} ms/file`)
    console.log(`  γ (per LOC×McCabe)    : ${model.gamma.toFixed(6)} ms/unit`)
    console.log(`  δ (per pass)          : ${model.delta.toFixed(2)} ms/pass`)
    console.log(`  MAPE                  : ${(model.mape * 100).toFixed(1)}%`)
    console.log(`  R²                    : ${model.rSquared.toFixed(3)}`)
    console.log(`  n datapoints          : ${model.nDatapoints}`)
    console.log(`  → ${path.relative(REPO_ROOT, MODEL_OUT)}`)
    return
  }

  if (arg === '--predict') {
    const detector = process.argv[3]
    if (!detector) {
      console.error('Usage: --predict <detector-name>')
      process.exit(1)
    }
    let model: CostModel
    try {
      model = JSON.parse(await fs.readFile(MODEL_OUT, 'utf-8'))
    } catch {
      console.error('Model not found — run --calibrate first')
      process.exit(1)
    }
    const ms = await predictDetector(detector, model)
    console.log(`[cost-estimator] predicted ${detector} = ${ms.toFixed(0)}ms`)
    return
  }

  if (arg === '--rank') {
    // Rank tous les détecteurs vs leurs prédictions, surface les outliers
    // (mean observed >> predicted = anomalie qui mérite enquête).
    let model: CostModel
    try {
      model = JSON.parse(await fs.readFile(MODEL_OUT, 'utf-8'))
    } catch {
      console.error('Model not found — run --calibrate first')
      process.exit(1)
    }
    const timings = await loadDetectorTimings()
    const rows: Array<{ name: string; observed: number; predicted: number; ratio: number }> = []
    for (const t of timings) {
      if (t.meanMs <= 0) continue
      const f = await buildFeatures(t.detector)
      const predicted = predictFromFeatures(model, f)
      const ratio = t.meanMs / Math.max(predicted, 1)
      rows.push({ name: t.detector, observed: t.meanMs, predicted, ratio })
    }
    rows.sort((a, b) => b.ratio - a.ratio)
    console.log('[cost-estimator] anomaly ranking (ratio > 1.5 = slower than predicted):')
    console.log('  detector'.padEnd(36) + 'observed'.padStart(12) + 'predicted'.padStart(12) + 'ratio'.padStart(8))
    for (const r of rows.slice(0, 10)) {
      console.log(
        '  ' + r.name.padEnd(34) +
          `${r.observed.toFixed(0)}ms`.padStart(12) +
          `${r.predicted.toFixed(0)}ms`.padStart(12) +
          r.ratio.toFixed(2).padStart(8),
      )
    }
    return
  }

  console.error(`Unknown arg: ${arg}`)
  console.error('Usage:')
  console.error('  --calibrate              fit the model from current facts')
  console.error('  --predict <detector>     predict warm cost from features')
  console.error('  --rank                   show observed/predicted ratios (anomalies)')
  process.exit(1)
}

main().catch((err) => {
  console.error('[cost-estimator] fatal:', err)
  process.exit(1)
})
