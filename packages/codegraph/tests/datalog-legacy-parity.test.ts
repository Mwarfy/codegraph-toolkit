// ADR-027
/**
 * Garde-fou de parité Datalog vs legacy detectors.
 *
 * Depuis Phase 3 d'ADR-027, le CLI `codegraph analyze` force
 * `useDatalog: true` par défaut (escape via env `LIBY_DATALOG_LEGACY=1`).
 * Si la parité Datalog/legacy se casse silencieusement, on s'en rendrait
 * pas compte — sauf via ce test.
 *
 * ADR-026 dit "18/21 ts-morph détecteurs portés, 30 facts BIT-IDENTICAL".
 * Ce test verrouille ce contrat en CI : 1 run legacy + 1 run Datalog
 * sur la même fixture → outputs structurels identiques sur les champs
 * patchés par Datalog (envUsage, barrels, eventEmitSites au moment de
 * l'écriture ; étendre si d'autres champs sont portés).
 *
 * Si le test casse :
 *   1. Soit le port Datalog d'un détecteur dérive du legacy → fix l'un
 *      des deux (probablement le port, le legacy étant la référence).
 *   2. Soit on a délibérément changé le legacy en sachant que Datalog
 *      diverge → mettre à jour ce test ET documenter la divergence
 *      dans ADR-026.
 *
 * Coût : ~5s (2 runs analyze sur fixture cycles).
 */

import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze } from '../src/core/analyzer.js'
import type { GraphSnapshot, CodeGraphConfig } from '../src/core/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function configFor(rootDir: string): CodeGraphConfig {
  return {
    rootDir,
    include: ['**/*.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    entryPoints: [],
    detectors: [],
    snapshotDir: path.join(rootDir, '.codegraph'),
    maxSnapshots: 50,
  }
}

/**
 * Hash canonique d'un champ snapshot — keys triées récursivement pour
 * éviter les faux negatifs d'ordre de propriétés. Skip `generatedAt`
 * et `commitHash` qui varient légitimement.
 */
function hashField(value: unknown): string {
  const json = JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(v).sort()) sorted[k] = (v as Record<string, unknown>)[k]
      return sorted
    }
    return v
  })
  return createHash('sha256').update(json).digest('hex').slice(0, 16)
}

async function run(rootDir: string, useDatalog: boolean): Promise<GraphSnapshot> {
  const result = await analyze(configFor(rootDir), {
    useDatalog,
    skipPersistenceLoad: true,
    skipPersistenceSave: true,
  })
  return result.snapshot
}

describe('Datalog/legacy parity — ADR-026/027 contract', () => {
  it('cycles fixture : Datalog vs legacy → bit-identical on patched fields', { timeout: 30_000 }, async () => {
    const rootDir = path.resolve(__dirname, 'fixtures/cycles')

    const dlSnap = await run(rootDir, true)
    const legacySnap = await run(rootDir, false)

    // Les champs patchés explicitement par le runner Datalog dans
    // analyzer.ts (env-usage, barrels, event-emit-sites) DOIVENT être
    // identiques. Si un nouveau champ est ajouté au override, mettre à
    // jour cette liste.
    const patchedFields: (keyof GraphSnapshot)[] = ['envUsage', 'barrels', 'eventEmitSites']

    for (const field of patchedFields) {
      const hDl = hashField(dlSnap[field])
      const hLegacy = hashField(legacySnap[field])
      expect(
        hDl,
        `field "${String(field)}" diverged between Datalog and legacy ` +
          `(Datalog=${hDl}, legacy=${hLegacy}) — see ADR-026 BIT-IDENTICAL contract`,
      ).toBe(hLegacy)
    }
  })

  it('cycles fixture : nodes + edges structure identical', { timeout: 30_000 }, async () => {
    const rootDir = path.resolve(__dirname, 'fixtures/cycles')

    const dlSnap = await run(rootDir, true)
    const legacySnap = await run(rootDir, false)

    // Le graphe lui-même (nodes/edges) ne doit pas dépendre du mode —
    // ts-imports tourne dans les deux. Hash des structures triées.
    const dlNodes = hashField([...dlSnap.nodes].sort((a, b) => a.id.localeCompare(b.id)))
    const legacyNodes = hashField([...legacySnap.nodes].sort((a, b) => a.id.localeCompare(b.id)))
    expect(dlNodes).toBe(legacyNodes)

    const sortEdge = (a: { from: string; to: string }, b: { from: string; to: string }) =>
      a.from.localeCompare(b.from) || a.to.localeCompare(b.to)
    const dlEdges = hashField([...dlSnap.edges].sort(sortEdge))
    const legacyEdges = hashField([...legacySnap.edges].sort(sortEdge))
    expect(dlEdges).toBe(legacyEdges)
  })
})
