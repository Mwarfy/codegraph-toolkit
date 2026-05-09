/**
 * Auto-baseline pour `NO-NEW-ARTICULATION-POINT`.
 *
 * Probleme resolu : la rule `no-new-articulation-point.dl` exige un fact
 * `ArticulationPointGrandfathered(file)` pour chaque cut-vertex existant
 * que l'on accepte (ratchet pattern : on bloque les NOUVELLES, pas
 * l'existant). Sans baseline, TOUS les cut-vertex sont reportes "nouveaux"
 * → bruit massif (137 violations sur happenin sans baseline).
 *
 * Solution : persister le set des fichiers articulation-point au premier
 * run dans `.codegraph/articulation-baseline.json`, et emettre les
 * `ArticulationPointGrandfathered` facts a partir de ce baseline.
 *
 * Cycle de vie :
 *   1. Premier run : pas de baseline → capture silencieuse, 0 violations
 *      NEW-ARTIC reportees (auto-grandfather de l'etat courant)
 *   2. Runs suivants : load baseline → grandfather facts emit, seules
 *      les nouvelles cut-vertex sont reportees
 *   3. User refactor majeur : delete `articulation-baseline.json` + re-run
 *
 * Recommande de commit `articulation-baseline.json` dans le repo (file
 * petit, deterministe, source-of-truth equipe).
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const BASELINE_FILENAME = 'articulation-baseline.json'

export interface ArticulationBaseline {
  /** ISO timestamp de creation. */
  createdAt: string
  /** Liste triee des fichiers articulation-point au moment du baseline. */
  grandfathered: string[]
}

export function articulationBaselinePath(rootDir: string, snapshotDir?: string): string {
  const dir = snapshotDir ?? path.join(rootDir, '.codegraph')
  return path.join(dir, BASELINE_FILENAME)
}

export async function loadArticulationBaseline(
  rootDir: string,
  snapshotDir?: string,
): Promise<ArticulationBaseline | null> {
  const p = articulationBaselinePath(rootDir, snapshotDir)
  try {
    const raw = await fs.readFile(p, 'utf-8')
    const parsed = JSON.parse(raw) as ArticulationBaseline
    if (Array.isArray(parsed.grandfathered)) return parsed
    return null
  } catch {
    return null
  }
}

export async function saveArticulationBaseline(
  rootDir: string,
  articulationFiles: readonly string[],
  snapshotDir?: string,
): Promise<void> {
  const p = articulationBaselinePath(rootDir, snapshotDir)
  await fs.mkdir(path.dirname(p), { recursive: true })
  const payload: ArticulationBaseline = {
    createdAt: new Date().toISOString(),
    grandfathered: [...articulationFiles].sort(),
  }
  await fs.writeFile(p, JSON.stringify(payload, null, 2) + '\n', 'utf-8')
}

/**
 * Resolve le set effectif de grandfathered articulation points :
 *   1. Si baseline existe → load + return
 *   2. Sinon → auto-create avec les articulations courantes + return
 */
export async function resolveGrandfatheredArticulations(
  rootDir: string,
  currentArticulationFiles: readonly string[],
  snapshotDir?: string,
): Promise<{ grandfathered: Set<string>; created: boolean }> {
  const existing = await loadArticulationBaseline(rootDir, snapshotDir)
  if (existing) {
    return { grandfathered: new Set(existing.grandfathered), created: false }
  }
  await saveArticulationBaseline(rootDir, currentArticulationFiles, snapshotDir)
  return { grandfathered: new Set(currentArticulationFiles), created: true }
}
