/**
 * Cycle temporal frequency — heuristique INSPIRÉE par TDA persistent
 * homology, **pas un véritable calcul d'homologie persistante**.
 *
 * ⚠ HONESTY DISCLAIMER : la persistent homology
 * (Edelsbrunner-Letscher-Zomorodian 2002) demande :
 *   - construction d'un complexe simplicial (≠ graphe d'imports)
 *   - filtration paramétrée (par ε ou edge weight desc)
 *   - calcul des Betti numbers via boundary matrices et Smith normal form
 *   - barcode (birth, death) en dim k via persistence pairing algorithm
 *
 * Aucun de ces éléments n'est implémenté ici. Ce que l'extracteur
 * calcule réellement :
 *
 *   persistence = appearances_in_snapshots / total_snapshots
 *
 * C'est une **fréquence temporelle** (= dans combien de snapshots
 * historiques le cycle apparaît). Le nom "persistent" est conservé
 * pour compatibilité backward, mais le concept réel est
 * "snapshot frequency", pas TDA persistence dim-1.
 *
 * NB : un VRAI calcul de persistence dim-0 sur edge-count filtration
 * existe dans `runtime-graph/src/metrics/tda-persistence.ts` (γ.2c).
 * Celui-ci est une heuristique git-historical différente.
 *
 * Utilité pratique (l'heuristique signal) :
 *   - frequency < 10% snapshots : cycle transient (bug refactor)
 *   - frequency ≥ 50% snapshots : cycle structurel (= accepter via gate)
 *
 * Compose avec composite-cycles + composite-nested-cycle :
 *   - frequency haute ∧ non-gated = vrai design issue
 *   - frequency basse ∧ recent = bug refactor incomplet
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export interface PersistentCycle {
  /** Cycle id (stable hash des nodes participants). */
  cycleId: string
  /** Sample des nodes du cycle (pour debug/display). */
  sampleNodes: string[]
  /** Nb de snapshots historiques ou le cycle apparait. */
  snapshotCount: number
  /** Total snapshots scannes. Persistence ratio = count / total. */
  totalSnapshots: number
  /** persistence × 1000 (= ratio en permille pour int Datalog). */
  persistenceX1000: number
  /** Premier snapshot ou le cycle apparait (ISO timestamp). */
  firstSeenIso: string
  /** Dernier snapshot ou le cycle apparait (ISO timestamp). */
  lastSeenIso: string
  /** True si le cycle est gated dans le snapshot le plus recent. */
  gated: boolean
}

interface SnapshotCycle {
  id: string
  nodes?: string[]
  gated?: boolean
}

interface SnapshotShape {
  generatedAt?: string
  cycles?: SnapshotCycle[]
}

/**
 * Scan les snapshots dans `.codegraph/` et calcule la persistence des
 * cycles via leur cycleId stable. Limit aux N derniers snapshots pour
 * eviter de trasher si l'historique est tres long (>1000 snapshots).
 */
export async function computePersistentCycles(
  rootDir: string,
  options: { maxSnapshots?: number } = {},
): Promise<PersistentCycle[]> {
  const maxSnapshots = options.maxSnapshots ?? 100
  const codegraphDir = path.join(rootDir, '.codegraph')

  let entries: string[]
  try {
    entries = await fs.readdir(codegraphDir)
  } catch {
    return []  // Pas de .codegraph/ — first run
  }

  const snapshotFiles = entries
    .filter((f) => /^snapshot-\d{4}-\d{2}-\d{2}T.*\.json$/.test(f))
    .sort()
    .slice(-maxSnapshots)

  if (snapshotFiles.length < 3) return []  // Pas assez d'historique

  const cycleStats = new Map<string, {
    sampleNodes: string[]
    snapshotCount: number
    firstSeenIso: string
    lastSeenIso: string
    gated: boolean
  }>()

  // Lit N snapshots en parallèle (I/O indépendantes), parse séquentiel.
  const snapshotEntries = await Promise.all(
    snapshotFiles.map(async (f) => {
      try {
        const raw = await fs.readFile(path.join(codegraphDir, f), 'utf8')
        return { f, snapshot: JSON.parse(raw) as SnapshotShape }
      } catch { return null }
    }),
  )
  for (const entry of snapshotEntries) {
    if (!entry) continue
    const { f, snapshot } = entry
    const generatedAt = snapshot.generatedAt ?? f.replace(/^snapshot-/, '').replace(/\.json$/, '')
    for (const c of snapshot.cycles ?? []) {
      const stats = cycleStats.get(c.id)
      if (!stats) {
        cycleStats.set(c.id, {
          sampleNodes: (c.nodes ?? []).slice(0, 5),
          snapshotCount: 1,
          firstSeenIso: generatedAt,
          lastSeenIso: generatedAt,
          gated: c.gated ?? false,
        })
      } else {
        stats.snapshotCount++
        stats.lastSeenIso = generatedAt
        // Update gated status to most recent
        stats.gated = c.gated ?? stats.gated
      }
    }
  }

  const totalSnapshots = snapshotFiles.length
  const out: PersistentCycle[] = []
  for (const [cycleId, stats] of cycleStats) {
    const persistence = stats.snapshotCount / totalSnapshots
    out.push({
      cycleId,
      sampleNodes: stats.sampleNodes,
      snapshotCount: stats.snapshotCount,
      totalSnapshots,
      persistenceX1000: Math.round(persistence * 1000),
      firstSeenIso: stats.firstSeenIso,
      lastSeenIso: stats.lastSeenIso,
      gated: stats.gated,
    })
  }
  out.sort((a, b) => b.persistenceX1000 - a.persistenceX1000)
  return out
}
