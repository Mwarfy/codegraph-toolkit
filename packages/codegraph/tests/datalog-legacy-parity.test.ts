// ADR-027 // ADR-031
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
 * patchés par Datalog.
 *
 * État ADR-031 Phase 1 (élargissement du garde-fou) :
 * L'audit Phase 0 (audit) supposait 3 fields en override actif. La
 * réalité (commits ADR-026 A.3/A.4/E) est que phases 1-6 d'analyzer.ts
 * branchent déjà `datalogPatch.X` pour 17 fields supplémentaires en
 * cascade. Phase 1 d'ADR-031 verrouille BIT-IDENTICAL en CI sur ces
 * 20 fields (au lieu de 3) pour donner un vrai garde-fou avant Phase 2
 * (retrait du code legacy).
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

    // ADR-031 Phase 2 batch 7 (FINAL) — tous les 18 détecteurs portés
    // ont leur source legacy ts-morph retirée. useDatalog=false ne
    // produit plus AUCUN de ces fields → patchedFields est vide.
    //
    // Le garde-fou bit-identical legacy/Datalog devient cosmétique : il
    // reste valable conceptuellement pour les FUTURS détecteurs ajoutés
    // en cascade (s'il en arrive un, l'ajouter ici lock parité dès J+1).
    //
    // `driftSignals` traverse l'adapter (adaptDriftSignalsFromDatalog) ;
    // sa parité est vérifiée séparément ci-dessous car il dépend de
    // snapshot.todos calculé hors-Datalog.
    const patchedFields: (keyof GraphSnapshot)[] = []

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

  // ADR-031 Phase 1 — second run sur la fixture canary qui injecte
  // délibérément des violations dans 9 catégories (cf. validate.sh). La
  // fixture cycles est trop minimaliste : la plupart des 20 fields sont
  // [] = [] des deux côtés et le test passe trivialement. Le canary
  // déclenche réellement la majorité des détecteurs, donc le BIT-IDENTICAL
  // sur ces fields est un vrai garde-fou (pas un hash vide=vide).
  it('canary fixture : Datalog vs legacy → bit-identical on 0 patched fields', { timeout: 120_000 }, async () => {
    const rootDir = path.resolve(__dirname, '../../../examples/canary-project')

    const dlSnap = await run(rootDir, true)
    const legacySnap = await run(rootDir, false)

    // ADR-031 Phase 2 batch 7 (FINAL) — 20 → 0 fields verrouillés. Tous
    // les détecteurs portés ont leur legacy ts-morph retiré. Le test
    // continue de tourner (nodes/edges parité vérifiée plus bas) ; cette
    // section devient vacuously true mais reste un canary contre un retour
    // accidentel d'un détecteur en cascade.
    const patchedFields: (keyof GraphSnapshot)[] = []

    // Trace coverage : combien de fields sont réellement déclenchés par
    // la fixture vs vides des deux côtés. Si la coverage tombe, c'est
    // un signal qu'il faut enrichir le canary, pas un signal de régression
    // parité.
    const triggered: string[] = []
    const empty: string[] = []
    const divergences: string[] = []
    for (const field of patchedFields) {
      const dlVal = dlSnap[field]
      const legacyVal = legacySnap[field]
      const dlCount = Array.isArray(dlVal) ? dlVal.length : 0
      const legacyCount = Array.isArray(legacyVal) ? legacyVal.length : 0
      if (dlCount > 0 || legacyCount > 0) triggered.push(String(field))
      else empty.push(String(field))

      const hDl = hashField(dlVal)
      const hLegacy = hashField(legacyVal)
      if (hDl !== hLegacy) {
        divergences.push(
          `${String(field)}: dl=${dlCount} (${hDl}) legacy=${legacyCount} (${hLegacy})`,
        )
      }
    }

    expect(
      divergences,
      `BIT-IDENTICAL contract violé — ADR-026 / ADR-031 Phase 1.\n` +
        `Fields divergents:\n  ${divergences.join('\n  ')}\n` +
        `Fields triggered (${triggered.length}): ${triggered.join(', ')}\n` +
        `Fields empty (${empty.length}): ${empty.join(', ')}`,
    ).toEqual([])

    // ADR-031 Phase 2 batch 7 (FINAL) — patchedFields vide : check
    // de coverage devient trivialement satisfait. Conservé pour future
    // réinsertion d'un détecteur en cascade.
    expect(triggered.length).toBeGreaterThanOrEqual(0)
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
