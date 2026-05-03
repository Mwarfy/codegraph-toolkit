/**
 * Tensions extractor — projette le snapshot vers une liste de "tensions
 * actives" : choses qui frottent dans le code (cycles, orphelins, FSM
 * incomplètes, deps inutilisées, etc.).
 *
 * L'esprit : chaque tension est une INVITATION À EXPLORER, pas un
 * verdict. Format compact qui active des patterns de raisonnement chez
 * un agent IA, avec un testHint qui rend l'hypothèse vérifiable.
 *
 * Convocations courtes :
 *   CYCLE       — boucle d'imports détectée (non-gated)
 *   ORPHELIN    — fichier sans aucun importeur
 *   FSM-DEAD    — état FSM jamais transitionné depuis (sortie morte)
 *   FSM-ORPHAN  — état FSM jamais écrit (déclaré mais inutilisé)
 *   DEP-UNUSED  — dépendance package.json déclarée jamais importée
 *   BARREL-LOW  — barrel index.ts à 1-2 exports (faible valeur)
 *   BACK-EDGE   — edge cross-container qui inverse l'ordre architectural
 */

// ADR-001: synopsis builder pur, zéro LLM, déterministe — tensions inclus
import type { GraphSnapshot } from '../core/types.js'

export type TensionKind =
  | 'cycle'
  | 'orphan'
  | 'fsm-dead'
  | 'fsm-orphan'
  | 'dep-unused'
  | 'barrel-low'
  | 'back-edge'

export interface Tension {
  /** Verbe court (CYCLE, ORPHELIN, etc.) — convocation */
  kind: TensionKind
  /** Coordonnées concrètes (file paths, symbole, etc.) */
  coordinates: string
  /** Note courte (≤80 chars) — pourquoi c'est une tension */
  note?: string
  /** Test/action que l'humain ou l'agent peut faire pour trancher */
  testHint?: string
}

export interface ExtractTensionsOptions {
  /** Max tensions par kind (default 5). Évite le spam sur gros projets. */
  maxPerKind?: number
  /** Skip kinds (ex: ['barrel-low'] si pas pertinent). */
  skip?: TensionKind[]
}

export function extractTensions(
  snapshot: GraphSnapshot,
  options: ExtractTensionsOptions = {},
): Tension[] {
  const maxPerKind = options.maxPerKind ?? 5
  const skip = new Set<TensionKind>(options.skip ?? [])
  const out: Tension[] = []

  if (!skip.has('cycle')) extractCycleTensions(snapshot, maxPerKind, out)
  if (!skip.has('orphan')) extractOrphanTensions(snapshot, maxPerKind, out)
  if (!skip.has('fsm-dead') || !skip.has('fsm-orphan')) {
    extractFsmTensions(snapshot, skip, maxPerKind, out)
  }
  if (!skip.has('dep-unused')) extractDepUnusedTensions(snapshot, maxPerKind, out)
  if (!skip.has('barrel-low')) extractBarrelLowTensions(snapshot, maxPerKind, out)
  if (!skip.has('back-edge')) extractBackEdgeTensions(snapshot, maxPerKind, out)

  return out
}

// ─── Cycles non-gated (les gated sont intentionnels) ───────────────────────

function extractCycleTensions(snapshot: GraphSnapshot, max: number, out: Tension[]): void {
  const cycles = (snapshot.cycles ?? []).filter((c) => !c.gated).slice(0, max)
  for (const c of cycles) {
    out.push({
      kind: 'cycle',
      coordinates: c.nodes.slice(0, -1).join(' → '),
      note: c.size === 2 ? 'boucle directe (2 fichiers)' : `boucle de ${c.size} fichiers`,
      testHint: 'inverser l\'import OU extraire dans un 3e fichier',
    })
  }
}

// ─── Orphelins (fichiers sans importeur) ───────────────────────────────────

function extractOrphanTensions(snapshot: GraphSnapshot, max: number, out: Tension[]): void {
  const orphans = (snapshot.nodes ?? [])
    .filter((n) => n.status === 'orphan' && n.type === 'file')
    .slice(0, max)
  for (const n of orphans) {
    out.push({
      kind: 'orphan',
      coordinates: n.id,
      note: 'aucun importeur',
      testHint: 'supprimer + npm test : si vert → mort, si rouge → entry-point caché',
    })
  }
}

// ─── FSM dead states + orphan states (1 seule itération sur snapshot.stateMachines) ───

function extractFsmTensions(
  snapshot: GraphSnapshot,
  skip: Set<TensionKind>,
  max: number,
  out: Tension[],
): void {
  const fsms = snapshot.stateMachines ?? []
  let deadCount = 0
  let orphanCount = 0
  for (const fsm of fsms) {
    if (!skip.has('fsm-dead')) {
      deadCount += pushFsmStates(
        fsm.deadStates ?? [],
        fsm.concept,
        max - deadCount,
        'fsm-dead',
        'état atteignable mais sans transition sortante',
        'ajouter la transition sortante OU retirer l\'état',
        out,
      )
    }
    if (!skip.has('fsm-orphan')) {
      orphanCount += pushFsmStates(
        fsm.orphanStates ?? [],
        fsm.concept,
        max - orphanCount,
        'fsm-orphan',
        'état déclaré mais jamais écrit dans le code',
        'supprimer l\'état OU ajouter la transition manquante',
        out,
      )
    }
  }
}

/** Push jusqu'à `budget` tensions de ce kind, return nb effectivement poussé. */
function pushFsmStates(
  states: readonly string[],
  concept: string,
  budget: number,
  kind: 'fsm-dead' | 'fsm-orphan',
  note: string,
  testHint: string,
  out: Tension[],
): number {
  if (budget <= 0) return 0
  const slice = states.slice(0, budget)
  for (const state of slice) {
    out.push({ kind, coordinates: `${concept}#${state}`, note, testHint })
  }
  return slice.length
}

// ─── Deps déclarées inutilisées ────────────────────────────────────────────

function extractDepUnusedTensions(snapshot: GraphSnapshot, max: number, out: Tension[]): void {
  const unused = (snapshot.packageDeps ?? [])
    .filter((i) => i.kind === 'declared-unused')
    .slice(0, max)
  for (const i of unused) {
    out.push({
      kind: 'dep-unused',
      coordinates: i.packageName,
      note: `déclaré dans ${i.packageJson}, jamais importé`,
      testHint: `npm uninstall ${i.packageName} + npm test`,
    })
  }
}

// ─── Barrels low-value (1-2 re-exports — friction inutile) ─────────────────

function extractBarrelLowTensions(snapshot: GraphSnapshot, max: number, out: Tension[]): void {
  const lows = (snapshot.barrels ?? []).filter((b) => b.lowValue).slice(0, max)
  for (const b of lows) {
    out.push({
      kind: 'barrel-low',
      coordinates: b.file,
      note: `barrel à ${b.reExportCount} re-export(s) pour ${b.consumerCount} consumer(s)`,
      testHint: 'inline les imports + supprimer le barrel',
    })
  }
}

// ─── Cross-container back-edges (frontend → backend, etc.) ─────────────────

function extractBackEdgeTensions(snapshot: GraphSnapshot, max: number, out: Tension[]): void {
  const dsm = snapshot.dsm
  if (!dsm?.backEdges || dsm.backEdges.length === 0) return
  for (const be of dsm.backEdges.slice(0, max)) {
    out.push({
      kind: 'back-edge',
      coordinates: `${be.from} → ${be.to}`,
      note: 'edge inverse l\'ordre architectural attendu',
      testHint: 'inverser la dépendance OU extraire un module partagé',
    })
  }
}

