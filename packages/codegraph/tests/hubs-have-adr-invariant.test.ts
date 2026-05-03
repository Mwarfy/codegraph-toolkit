/**
 * Self-discipline invariant — every load-bearing file MUST have ADR governance.
 *
 * Mathematical rule (defendable threshold) :
 *   Un fichier est "load-bearing" si fan-in (= nb d'importeurs) ≥ 3.
 *   Pour ces fichiers, modifier sans ADR a un blast radius non négligeable
 *   (≥ 3 dépendants peuvent casser silencieusement). On exige donc :
 *
 *     ∀ fichier f tel que fan_in(f) ≥ 3 ET f ∈ src/ :
 *         f a un marqueur `// ADR-NNN` dans ses 5 premières lignes.
 *
 * Pourquoi le seuil 3 :
 *   - 1 importeur : utilitaire local, blast radius minimal — pas besoin d'ADR.
 *   - 2 importeurs : pattern qui émerge, ADR optional.
 *   - 3+ importeurs : pattern établi, modifications affectent le système — ADR mandatory.
 *
 * Exclusions :
 *   - dist/ : artefacts compilés (re-exports automatiques).
 *   - tests/fixtures/ : code intentionnellement minimal.
 *   - .d.ts files : declarations only, governance-free.
 *
 * Si ce test pète :
 *   1. Soit le fichier flag est légitimement load-bearing → poser un ADR
 *      marker (et créer un nouvel ADR si la décision n'est pas couverte).
 *   2. Soit le fan-in est artificiel (re-exports, barrel) → refactor pour
 *      réduire le couplage.
 *
 * C'est l'invariant qui empêche le dogfood ratio de régresser.
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../../..')

const FAN_IN_THRESHOLD = 3

/** Trouve le snapshot codegraph le plus récent. */
async function loadLatestSnapshot(): Promise<{ nodes: any[]; edges: any[] }> {
  const codegraphDir = path.join(REPO_ROOT, '.codegraph')
  const entries = await fs.readdir(codegraphDir).catch(() => [])
  const snapshots = entries.filter((f) => f.startsWith('snapshot-') && f.endsWith('.json'))
  if (snapshots.length === 0) {
    throw new Error('No codegraph snapshot found — run `npx codegraph analyze` first')
  }
  // Latest = lex-last (timestamp dans le filename)
  snapshots.sort()
  const latest = snapshots[snapshots.length - 1]
  const content = await fs.readFile(path.join(codegraphDir, latest), 'utf-8')
  return JSON.parse(content)
}

/** Compte les importeurs (fan-in) de chaque fichier. */
function computeFanIn(edges: any[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const e of edges) {
    if (e.type !== 'import') continue
    counts.set(e.to, (counts.get(e.to) ?? 0) + 1)
  }
  return counts
}

/** True si le fichier a un marqueur `// ADR-NNN` dans les premières lignes. */
async function hasAdrMarker(absPath: string): Promise<boolean> {
  try {
    const content = await fs.readFile(absPath, 'utf-8')
    const head = content.split('\n').slice(0, 10).join('\n')
    return /\/\/\s*ADR-\d+/.test(head)
  } catch {
    return false
  }
}

function shouldGate(filePath: string): boolean {
  // Exclude dist/, fixtures, .d.ts, examples
  if (filePath.includes('/dist/')) return false
  if (filePath.includes('/tests/fixtures/')) return false
  if (filePath.includes('/examples/')) return false
  if (filePath.endsWith('.d.ts')) return false
  if (!filePath.endsWith('.ts')) return false
  return true
}

describe('Self-discipline invariant — load-bearing files have ADR governance', () => {
  it('every fan-in ≥ 3 file in src/ has an ADR marker (mathematical gate)', async () => {
    const snapshot = await loadLatestSnapshot()
    const fanIn = computeFanIn(snapshot.edges)

    // Top hubs above threshold
    const hubs = [...fanIn.entries()]
      .filter(([file, count]) => count >= FAN_IN_THRESHOLD && shouldGate(file))
      .sort((a, b) => b[1] - a[1])

    expect(hubs.length, 'at least 5 hubs detected (sanity)').toBeGreaterThanOrEqual(5)

    // Vérifie ADR marker sur chaque hub
    const violations: Array<{ file: string; fanIn: number }> = []
    for (const [file, count] of hubs) {
      const absPath = path.join(REPO_ROOT, file)
      if (!(await hasAdrMarker(absPath))) {
        violations.push({ file, fanIn: count })
      }
    }

    if (violations.length > 0) {
      const msg = violations
        .map((v) => `  - ${v.file} (fan-in: ${v.fanIn})`)
        .join('\n')
      throw new Error(
        `Found ${violations.length} load-bearing file(s) without ADR marker:\n${msg}\n\n` +
          'Pose a "// ADR-NNN" marker (top of file) or create a new ADR if ' +
          'the decision is not already covered. Reduce fan-in if the coupling ' +
          'is artificial (barrel re-exports etc.).',
      )
    }
  })

  it('reports current dogfood ratio (informational)', async () => {
    const snapshot = await loadLatestSnapshot()
    const fanIn = computeFanIn(snapshot.edges)
    const hubs = [...fanIn.entries()]
      .filter(([file, count]) => count >= FAN_IN_THRESHOLD && shouldGate(file))

    let governed = 0
    for (const [file] of hubs) {
      if (await hasAdrMarker(path.join(REPO_ROOT, file))) governed++
    }

    const ratio = hubs.length > 0 ? governed / hubs.length : 1
    // Information : log to console — vitest captures it.
    console.log(
      `\n[dogfood] Load-bearing hubs (fan-in ≥ ${FAN_IN_THRESHOLD}) governed: ` +
        `${governed}/${hubs.length} = ${(ratio * 100).toFixed(0)}%`,
    )

    // Sanity check : the previous test enforces 100% — this should always be 1.0.
    expect(ratio).toBe(1)
  })
})
