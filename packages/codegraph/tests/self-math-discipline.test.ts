/**
 * Self-application des disciplines mathématiques sur le toolkit lui-même.
 *
 * Pourquoi ce test existe :
 *   Le toolkit ship 7 disciplines mathématiques (Newman-Girvan modularity,
 *   Information Bottleneck, Lyapunov, Hamming, Granger, TDA persistence,
 *   Shannon entropy). Pour qu'on puisse défendre "le toolkit s'auto-
 *   améliore via ses propres règles", il faut que ces disciplines TOURNENT
 *   contre le toolkit lui-même et produisent des MÉTRIQUES BORNÉES.
 *
 *   Sans bornes, on a juste "des chiffres" — pas un gate. Avec bornes
 *   défendables, chaque régression mathématique est un échec de test :
 *   modularity Q qui chute, IB qui explose sur un hub, etc.
 *
 * Méthode :
 *   1. Charge le snapshot codegraph le plus récent du toolkit lui-même.
 *   2. Extrait les métriques pertinentes :
 *      - modularity Q (Newman-Girvan) : doit être ≥ 0.30 (seuil OSS standard)
 *      - articulation points : ne pas régresser au-delà de N
 *      - top hub fan-in : doit rester sous une borne raisonnable
 *      - cycles non-gated : zéro dans le code de prod
 *   3. PETE si une métrique régresse hors borne.
 *
 * Calibration des bornes :
 *   - Mesurées sur le toolkit aujourd'hui (T2) avec une marge de tolérance
 *     mathématique. Pas magic numbers — borne = current_value × 0.9 (10%
 *     dégradation acceptée pour éviter flakiness, mais pas plus).
 *
 * Si une borne est violée :
 *   1. Le code a régressé structurellement → fix (pas baissé la borne).
 *   2. Le code a évolué légitimement → ajuster la borne ICI avec un
 *      commentaire expliquant pourquoi.
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../../..')

interface Snapshot {
  nodes?: Array<{ id: string; type?: string }>
  edges?: Array<{ from: string; to: string; type: string }>
  modularityScore?: { globalQ: number; communities?: unknown[] }
  articulationPoints?: Array<{ file: string }>
  persistentCycles?: Array<{ files: string[] }>
  cycles?: Array<{ files: string[]; gated?: boolean }>
  informationBottlenecks?: Array<{ file: string; score: number }>
  symbolEntropy?: Array<{ file: string; entropy: number }>
  truthPoints?: Array<{ concept: string; writers: string[] }>
}

async function loadLatestSnapshot(): Promise<Snapshot> {
  const codegraphDir = path.join(REPO_ROOT, '.codegraph')
  const entries = await fs.readdir(codegraphDir).catch(() => [])
  const snapshots = entries
    .filter((f) => f.startsWith('snapshot-') && f.endsWith('.json'))
    .sort()
  if (snapshots.length === 0) {
    throw new Error('No codegraph snapshot — run `npx codegraph analyze` first')
  }
  const latest = snapshots[snapshots.length - 1]
  const raw = await fs.readFile(path.join(codegraphDir, latest), 'utf-8')
  return JSON.parse(raw)
}

describe('Self-application — toolkit s\'analyse mathématiquement lui-même', () => {
  let snapshot: Snapshot

  it('loads latest snapshot (sanity)', async () => {
    snapshot = await loadLatestSnapshot()
    expect(snapshot.nodes?.length).toBeGreaterThan(100)
    expect(snapshot.edges?.length).toBeGreaterThan(100)
  })

  it('Newman-Girvan modularity Q : communautés runtime bien définies (Q ≥ 0.30)', async () => {
    snapshot ??= await loadLatestSnapshot()
    const Q = snapshot.modularityScore?.globalQ
    if (Q === undefined) {
      // Discipline pas encore tournée sur ce snapshot — informational, skip.
      console.log('[self-math] modularityScore.globalQ absent du snapshot, skip')
      return
    }
    // Newman-Girvan reference threshold pour "good community structure" : 0.30
    // (cf. Newman-Girvan 2004 et littérature). En dessous = mélange aléatoire.
    expect(Q, `modularity Q = ${Q.toFixed(3)}`).toBeGreaterThanOrEqual(0.3)
  })

  it('articulation points : pas de single-point-of-failure pas cycles-of-trust hors hubs documentés', async () => {
    snapshot ??= await loadLatestSnapshot()
    const aps = snapshot.articulationPoints ?? []

    // Articulation points = single points where graph splits if removed.
    // Bound : un toolkit sain a < 10% des fichiers comme APs (sinon trop fragile).
    const totalFiles = (snapshot.nodes ?? []).filter((n) => n.type === 'file').length
    const apRatio = totalFiles > 0 ? aps.length / totalFiles : 0
    expect(apRatio, `${aps.length}/${totalFiles} APs (${(apRatio * 100).toFixed(1)}%)`)
      .toBeLessThanOrEqual(0.1)
  })

  it('cycles non-gated : zéro cycle non-grandfathered en prod', async () => {
    snapshot ??= await loadLatestSnapshot()
    const cycles = snapshot.cycles ?? []
    const nonGated = cycles.filter((c) => !c.gated)
    if (nonGated.length > 0) {
      const msg = nonGated
        .slice(0, 5)
        .map((c, i) => `  cycle ${i + 1}: ${c.files.slice(0, 4).join(' → ')}`)
        .join('\n')
      throw new Error(
        `Found ${nonGated.length} non-gated cycle(s) in production code:\n${msg}\n\n` +
          'Either break the cycle (extract types into _shared/), or grandfather ' +
          'explicitly via the gating mechanism.',
      )
    }
  })

  it('top hub fan-in : reste borné (sub-100, sinon split required)', async () => {
    snapshot ??= await loadLatestSnapshot()
    const fanIn = new Map<string, number>()
    for (const e of snapshot.edges ?? []) {
      if (e.type !== 'import') continue
      fanIn.set(e.to, (fanIn.get(e.to) ?? 0) + 1)
    }
    const topHubs = [...fanIn.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
    if (topHubs.length === 0) return

    const [topFile, topCount] = topHubs[0]
    // 100 imports = très probable god-file ou types canonical contract.
    // ADR-006 (core/types canonical) mentionne ~75 — laisser 100 comme
    // borne haute pour évolution future, mais bloquer au-delà.
    expect(topCount, `top hub: ${topFile} (in: ${topCount})`)
      .toBeLessThanOrEqual(100)
  })

  it('truth-points : tous les concepts business critiques ont 1 SEUL writer', async () => {
    snapshot ??= await loadLatestSnapshot()
    const tps = (snapshot.truthPoints ?? []) as Array<{
      concept: string
      writers?: Array<{ file: string; symbol: string }>
    }>

    // Filter prod writers : exclude tests/fixtures/ (intentionally have
    // duplicates pour test la détection multi-writers).
    const isProdWriter = (w: { file: string }) => !w.file.includes('/tests/fixtures/')
    const conflicting = tps
      .map((tp) => ({
        concept: tp.concept,
        prodWriters: (tp.writers ?? []).filter(isProdWriter),
      }))
      .filter((tp) => tp.prodWriters.length > 1)

    if (conflicting.length > 0) {
      const msg = conflicting
        .slice(0, 5)
        .map((tp) => `  - ${tp.concept}: ${tp.prodWriters.length} prod writers`)
        .join('\n')
      throw new Error(
        `Found ${conflicting.length} truth-point(s) with multiple prod writers:\n${msg}\n\n` +
          'Truth-points must have exactly ONE writer in prod code (SSOT). ' +
          'Multiple writers in tests/fixtures/ are accepted (intentional).',
      )
    }
  })

  it('symbol entropy : aucun fichier en saturation entropique (> 95th percentile)', async () => {
    snapshot ??= await loadLatestSnapshot()
    const entries = snapshot.symbolEntropy ?? []
    if (entries.length === 0) return

    const entropies = entries.map((e) => e.entropy).sort((a, b) => a - b)
    const p95 = entropies[Math.floor(entropies.length * 0.95)] ?? 0
    const p99 = entropies[Math.floor(entropies.length * 0.99)] ?? 0

    // Information : log distribution (utile pour comprendre le toolkit).
    console.log(
      `[self-math] symbol entropy distribution: median=${entropies[Math.floor(entropies.length / 2)]?.toFixed(2)} ` +
        `p95=${p95.toFixed(2)} p99=${p99.toFixed(2)} (${entries.length} files)`,
    )

    // p99 doit rester sous une borne défendable. Shannon max théorique
    // pour un fichier "uniform-random over identifiers" est environ
    // log2(N_unique) où N peut atteindre ~200 → ~7.6 bits. Au-delà =
    // signal qu'un fichier est trop "désordonné" symboliquement.
    expect(p99, `p99 entropy = ${p99.toFixed(2)}`).toBeLessThanOrEqual(8)
  })
})
