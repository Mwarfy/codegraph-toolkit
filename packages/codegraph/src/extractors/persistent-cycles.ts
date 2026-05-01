/**
 * Persistent cycles — Topological Data Analysis (TDA) approximation.
 *
 * Origine : la persistent homology (Edelsbrunner-Letscher-Zomorodian
 * 2002) etudie comment les invariants topologiques (composantes connexes
 * H₀, cycles H₁) apparaissent et disparaissent au cours d'une filtration.
 *
 * Application au code : un cycle d'imports qui APPARAIT puis DISPARAIT
 * dans l'historique git est probablement accidentel (introduit par un
 * commit specifique, retire par un refactor). A l'inverse, un cycle
 * present dans la majorite des snapshots historiques = cycle
 * STRUCTUREL inherent a l'architecture.
 *
 * Distinction :
 *   - persistence faible (1-3 snapshots) : cycle accidentel, transient
 *   - persistence haute (≥ 50% des snapshots) : cycle inherent, design
 *     decision implicite. Souvent valide a accepter (gated) plutot
 *     qu'a essayer de refactorer.
 *
 * Approche pratique : pour chaque cycle (identifie par son id stable
 * = hash des nodes participants), compter dans combien de snapshots
 * historiques il apparait.
 *
 * Compose avec composite-cycles + composite-nested-cycle :
 *   - cycle persistent (>50% snapshots) ∧ non-gated = vrai design issue
 *   - cycle transient (<10% snapshots) ∧ recent = bug refactor incomplet
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

  for (const f of snapshotFiles) {
    const fullPath = path.join(codegraphDir, f)
    let snapshot: SnapshotShape
    try {
      const raw = await fs.readFile(fullPath, 'utf8')
      snapshot = JSON.parse(raw)
    } catch {
      continue
    }
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
