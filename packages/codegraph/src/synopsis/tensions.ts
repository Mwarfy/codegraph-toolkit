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

  // ─── Cycles non-gated (les gated sont intentionnels) ────────────────
  if (!skip.has('cycle')) {
    const cycles = (snapshot.cycles ?? []).filter(c => !c.gated).slice(0, maxPerKind)
    for (const c of cycles) {
      const path = c.nodes.slice(0, -1).join(' → ')
      out.push({
        kind: 'cycle',
        coordinates: path,
        note: c.size === 2 ? 'boucle directe (2 fichiers)' : `boucle de ${c.size} fichiers`,
        testHint: 'inverser l\'import OU extraire dans un 3e fichier',
      })
    }
  }

  // ─── Orphelins (fichiers sans importeur) ────────────────────────────
  if (!skip.has('orphan')) {
    const orphans = (snapshot.nodes ?? [])
      .filter(n => n.status === 'orphan' && n.type === 'file')
      .slice(0, maxPerKind)
    for (const n of orphans) {
      out.push({
        kind: 'orphan',
        coordinates: n.id,
        note: 'aucun importeur',
        testHint: 'supprimer + npm test : si vert → mort, si rouge → entry-point caché',
      })
    }
  }

  // ─── FSM dead states (cible mais jamais source) ─────────────────────
  // ─── FSM orphan states (déclarés mais jamais écrits) ────────────────
  if (!skip.has('fsm-dead') || !skip.has('fsm-orphan')) {
    const fsms = snapshot.stateMachines ?? []
    let deadCount = 0
    let orphanCount = 0
    for (const fsm of fsms) {
      if (!skip.has('fsm-dead')) {
        for (const state of fsm.deadStates ?? []) {
          if (deadCount >= maxPerKind) break
          out.push({
            kind: 'fsm-dead',
            coordinates: `${fsm.concept}#${state}`,
            note: 'état atteignable mais sans transition sortante',
            testHint: 'ajouter la transition sortante OU retirer l\'état',
          })
          deadCount++
        }
      }
      if (!skip.has('fsm-orphan')) {
        for (const state of fsm.orphanStates ?? []) {
          if (orphanCount >= maxPerKind) break
          out.push({
            kind: 'fsm-orphan',
            coordinates: `${fsm.concept}#${state}`,
            note: 'état déclaré mais jamais écrit dans le code',
            testHint: 'supprimer l\'état OU ajouter la transition manquante',
          })
          orphanCount++
        }
      }
    }
  }

  // ─── Deps déclarées inutilisées ──────────────────────────────────────
  if (!skip.has('dep-unused')) {
    const issues = snapshot.packageDeps ?? []
    const unused = issues.filter(i => i.kind === 'declared-unused').slice(0, maxPerKind)
    for (const i of unused) {
      out.push({
        kind: 'dep-unused',
        coordinates: i.packageName,
        note: `déclaré dans ${i.packageJson}, jamais importé`,
        testHint: `npm uninstall ${i.packageName} + npm test`,
      })
    }
  }

  // ─── Barrels low-value (1-2 re-exports — friction inutile) ──────────
  if (!skip.has('barrel-low')) {
    const lows = (snapshot.barrels ?? []).filter(b => b.lowValue).slice(0, maxPerKind)
    for (const b of lows) {
      out.push({
        kind: 'barrel-low',
        coordinates: b.file,
        note: `barrel à ${b.reExportCount} re-export(s) pour ${b.consumerCount} consumer(s)`,
        testHint: 'inline les imports + supprimer le barrel',
      })
    }
  }

  // ─── Cross-container back-edges (frontend → backend, etc.) ───────────
  if (!skip.has('back-edge')) {
    const dsm = snapshot.dsm
    if (dsm && dsm.backEdges && dsm.backEdges.length > 0) {
      for (const be of dsm.backEdges.slice(0, maxPerKind)) {
        out.push({
          kind: 'back-edge',
          coordinates: `${be.from} → ${be.to}`,
          note: 'edge inverse l\'ordre architectural attendu',
          testHint: 'inverser la dépendance OU extraire un module partagé',
        })
      }
    }
  }

  return out
}

