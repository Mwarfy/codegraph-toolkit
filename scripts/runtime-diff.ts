/**
 * Runtime diff — compare le DetectorTiming.facts courant à la baseline
 * archivée et écrit un rapport dans `.codegraph/runtime-diff.md`.
 *
 * Workflow :
 *   1. L'humain lance `npx tsx scripts/self-runtime-probe.ts` quand il
 *      veut une nouvelle mesure (~10s). Le probe :
 *        - archive l'ancien DetectorTiming.facts → baseline/
 *        - écrit le nouveau DetectorTiming.facts
 *   2. À chaque commit, le post-commit hook appelle ce script (~50ms,
 *      lit juste les .facts). Le diff est injecté dans le brief par
 *      inject-self-optim-brief.ts.
 *
 * Output : `.codegraph/runtime-diff.md` (markdown table régressions/wins)
 *
 * Régression p95 > 20% sur n'importe quel détecteur → flagged.
 * Win p95 < -10% → noted (cf. on a optimisé quelque chose).
 *
 * Si `baseline/DetectorTiming.facts` n'existe pas → skip silencieusement
 * (premier run jamais fait).
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

const FACTS_DIR = path.join(REPO_ROOT, '.codegraph/facts-self-runtime')
const CURRENT = path.join(FACTS_DIR, 'DetectorTiming.facts')
const BASELINE = path.join(FACTS_DIR, 'baseline/DetectorTiming.facts')
const OUT = path.join(REPO_ROOT, '.codegraph/runtime-diff.md')

const REGRESSION_THRESHOLD = 0.20  // +20% p95
const WIN_THRESHOLD = -0.10        // -10% p95

interface Timing {
  detector: string
  meanMs: number
  p95Ms: number
  stdDevX1000: number
  lambdaX1000: number
}

async function readTiming(file: string): Promise<Map<string, Timing>> {
  const out = new Map<string, Timing>()
  try {
    const text = await fs.readFile(file, 'utf-8')
    for (const line of text.trim().split('\n')) {
      if (!line) continue
      const cols = line.split('\t')
      // schema : (detector, runs, meanMs, p95Ms, stdDevX1000, lambdaX1000)
      if (cols.length < 6) continue
      out.set(cols[0], {
        detector: cols[0],
        meanMs: parseFloat(cols[2]),
        p95Ms: parseFloat(cols[3]),
        stdDevX1000: parseFloat(cols[4]),
        lambdaX1000: parseFloat(cols[5]),
      })
    }
  } catch {
    // missing file — return empty
  }
  return out
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true } catch { return false }
}

async function main(): Promise<void> {
  if (!(await exists(CURRENT))) {
    // Pas de probe jamais lancé — rien à diff
    return
  }
  if (!(await exists(BASELINE))) {
    // Premier run — pas de baseline. On clean l'output potentiel.
    await fs.rm(OUT, { force: true })
    return
  }

  const current = await readTiming(CURRENT)
  const baseline = await readTiming(BASELINE)

  const regressions: Array<{ detector: string; oldP95: number; newP95: number; deltaPct: number }> = []
  const wins: typeof regressions = []

  for (const [name, cur] of current.entries()) {
    const base = baseline.get(name)
    if (!base) continue  // nouveau détecteur — pas un diff
    if (base.p95Ms <= 0) continue
    const delta = (cur.p95Ms - base.p95Ms) / base.p95Ms
    if (delta >= REGRESSION_THRESHOLD) {
      regressions.push({ detector: name, oldP95: base.p95Ms, newP95: cur.p95Ms, deltaPct: delta * 100 })
    } else if (delta <= WIN_THRESHOLD) {
      wins.push({ detector: name, oldP95: base.p95Ms, newP95: cur.p95Ms, deltaPct: delta * 100 })
    }
  }

  regressions.sort((a, b) => b.deltaPct - a.deltaPct)
  wins.sort((a, b) => a.deltaPct - b.deltaPct)

  if (regressions.length === 0 && wins.length === 0) {
    await fs.rm(OUT, { force: true })
    return
  }

  const lines: string[] = []
  lines.push('# Runtime diff — current vs baseline')
  lines.push('')
  lines.push(`> Auto-généré par \`scripts/runtime-diff.ts\` après chaque commit. Seuils : régression ≥ +${REGRESSION_THRESHOLD * 100}% p95, win ≤ ${WIN_THRESHOLD * 100}%.`)
  lines.push(`> Pour rafraîchir la baseline : \`npx tsx scripts/self-runtime-probe.ts\` (~10s).`)
  lines.push('')

  if (regressions.length > 0) {
    lines.push(`## ⚠ ${regressions.length} régression(s) p95`)
    lines.push('')
    lines.push('| Détecteur | baseline p95 | current p95 | delta |')
    lines.push('|---|---:|---:|---:|')
    for (const r of regressions) {
      lines.push(`| \`${r.detector}\` | ${r.oldP95.toFixed(1)}ms | ${r.newP95.toFixed(1)}ms | **+${r.deltaPct.toFixed(0)}%** |`)
    }
    lines.push('')
  }

  if (wins.length > 0) {
    lines.push(`## ✓ ${wins.length} amélioration(s) p95`)
    lines.push('')
    lines.push('| Détecteur | baseline p95 | current p95 | delta |')
    lines.push('|---|---:|---:|---:|')
    for (const w of wins) {
      lines.push(`| \`${w.detector}\` | ${w.oldP95.toFixed(1)}ms | ${w.newP95.toFixed(1)}ms | **${w.deltaPct.toFixed(0)}%** |`)
    }
    lines.push('')
  }

  await fs.writeFile(OUT, lines.join('\n'), 'utf-8')
}

main().catch((err) => {
  console.error('runtime-diff failed:', err)
  process.exit(0)  // best-effort — ne fail jamais le hook
})
