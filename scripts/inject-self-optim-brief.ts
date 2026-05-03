/**
 * Inject self-optim opportunities into BOOT-BRIEF / CLAUDE-CONTEXT.md.
 *
 * Lit `.codegraph/facts-self-runtime/DetectorTiming.facts` (produit par
 * `self-runtime-probe.ts`) et insère une section "Self-optim opportunities"
 * dans le brief, listant les détecteurs candidates par ROI math décroissant.
 *
 * ROI = mean × (1 - 1/λ_lyap)  [gain estimé si Salsa-isé : mean × cache_factor]
 *
 * Exécuté par le post-commit hook après le brief, ne tourne QUE si les
 * facts existent (le probe doit avoir tourné). Pas de hard dépendance.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

const FACTS_FILE = path.join(REPO_ROOT, '.codegraph/facts-self-runtime/DetectorTiming.facts')
const BRIEF_FILE = path.join(REPO_ROOT, 'CLAUDE-CONTEXT.md')

const HOT_THRESHOLD_MS = 200
const NO_CACHE_LAMBDA_X1000_MAX = 1100                                       // 1.10 × 1000

/**
 * Détecteurs exempts : pattern non-cacheable par design (cross-snapshot,
 * I/O dominé, etc.). Doit matcher EXEMPT_DETECTORS de
 * `tests/self-runtime-regression.test.ts` pour cohérence.
 */
const EXEMPT_DETECTORS = new Set([
  'persistent-cycles',                                                       // cross-snapshot history
  'fact-stability',                                                          // cross-snapshot temporal
])

interface CandidateRow {
  detector: string
  meanMs: number
  p95Ms: number
  lambda: number
  roiMs: number
}

async function loadCandidates(): Promise<CandidateRow[]> {
  let raw: string
  try {
    raw = await fs.readFile(FACTS_FILE, 'utf-8')
  } catch {
    return []
  }

  const candidates: CandidateRow[] = []
  for (const line of raw.trim().split('\n')) {
    const cols = line.split('\t')
    if (cols.length < 6) continue
    const [detector, _runs, meanStr, p95Str, _stdDev, lambdaX1000Str] = cols
    const meanMs = parseInt(meanStr, 10)
    const p95Ms = parseInt(p95Str, 10)
    const lambdaX1000 = parseInt(lambdaX1000Str, 10)
    if (meanMs < HOT_THRESHOLD_MS) continue
    if (lambdaX1000 > NO_CACHE_LAMBDA_X1000_MAX) continue                    // already cached
    if (EXEMPT_DETECTORS.has(detector)) continue                             // by-design non-cacheable
    const lambda = lambdaX1000 / 1000
    // ROI = potential warm-time saving = mean × (1 - 1/λ_after).
    // We estimate λ_after as the median observed for cached detectors (~25).
    // So gain ≈ mean × (1 - 1/25) = mean × 0.96.
    const roiMs = Math.floor(meanMs * 0.96)
    candidates.push({ detector, meanMs, p95Ms, lambda, roiMs })
  }
  candidates.sort((a, b) => b.roiMs - a.roiMs)
  return candidates
}

function renderSection(candidates: CandidateRow[]): string {
  if (candidates.length === 0) {
    return '## Self-optim opportunities\n\n' +
      'Aucune opportunité détectée — tous les hot detectors sont cached. ✓\n'
  }

  const lines: string[] = []
  lines.push('## Self-optim opportunities')
  lines.push('')
  lines.push(
    '> Auto-detected via self-runtime-probe + Lyapunov-like λ analysis. ' +
      'Détecteurs hot (mean ≥ 200ms warm) avec λ ≤ 1.10 = pas de cache effectif. ' +
      'ROI = gain estimé en ms si Salsa-isé.',
  )
  lines.push('')
  lines.push('| Detector | mean (ms) | p95 (ms) | λ_lyap | ROI estimé |')
  lines.push('|---|---|---|---|---|')
  for (const c of candidates.slice(0, 10)) {
    lines.push(
      `| \`${c.detector}\` | ${c.meanMs} | ${c.p95Ms} | ${c.lambda.toFixed(2)} | **−${c.roiMs}ms** |`,
    )
  }
  lines.push('')
  lines.push('Pour optimiser : `./scripts/scaffold-salsa.sh <detector>` puis suivre les next steps.')
  lines.push('')
  return lines.join('\n')
}

async function main(): Promise<void> {
  const candidates = await loadCandidates()
  const section = renderSection(candidates)

  let brief = ''
  try {
    brief = await fs.readFile(BRIEF_FILE, 'utf-8')
  } catch {
    console.error(`[inject-self-optim] BRIEF_FILE not found: ${BRIEF_FILE}`)
    process.exit(0) // soft-fail
  }

  const MARKER_START = '<!-- SELF-OPTIM-START -->'
  const MARKER_END = '<!-- SELF-OPTIM-END -->'

  const wrapped = `${MARKER_START}\n${section}${MARKER_END}`

  if (brief.includes(MARKER_START) && brief.includes(MARKER_END)) {
    // Replace existing
    const re = new RegExp(`${MARKER_START}[\\s\\S]*?${MARKER_END}`, 'm')
    brief = brief.replace(re, wrapped)
  } else {
    // Append at end
    brief = brief.trimEnd() + '\n\n' + wrapped + '\n'
  }

  await fs.writeFile(BRIEF_FILE, brief, 'utf-8')
  console.log(
    `[inject-self-optim] ${candidates.length} candidate(s) injected into ${path.relative(REPO_ROOT, BRIEF_FILE)}`,
  )
}

main().catch((err) => {
  console.error('[inject-self-optim] fatal:', err)
  process.exit(0) // soft-fail to not block hooks
})
