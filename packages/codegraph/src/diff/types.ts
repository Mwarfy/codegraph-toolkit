/**
 * Types du module `diff` — phase 3 du PLAN.md.
 *
 * `StructuralDiff` étend la notion de `SnapshotDiff` (qui ne couvre que
 * nodes + edges basiques) aux 5 sections de phase 1 : typedCalls,
 * cycles, truthPoints, dataFlows, stateMachines.
 *
 * L'objectif : répondre à « qu'est-ce qui a changé structurellement ? »
 * plutôt qu'à « quels fichiers ont bougé ? ».
 *
 * Règles :
 *   - Déterministe. Deux runs sur la même paire → octet-équivalent.
 *   - Pas d'approximation : un élément est `added` si sa clé ne figurait
 *     pas dans `before`, `removed` si elle ne figure pas dans `after`,
 *     `modified`/`changed` seulement quand on peut formuler un delta
 *     concret (listes différées, signatures différentes, etc.).
 *   - Silence-par-défaut : une section vide dans les deux snapshots
 *     produit des tableaux vides. Pas d'entrée « no-op » bruyante.
 */

import type {
  Cycle,
  DataFlowEntry,
  DataFlowSink,
  StateMachine,
  StateTransition,
  TruthExposure,
  TruthMirror,
  TruthPoint,
  TruthRef,
  TypedSignature,
} from '../core/types.js'

// ─── Cycles ─────────────────────────────────────────────────────────────────

/**
 * Un cycle dont le statut gated a changé entre before et after. L'identité
 * est préservée (même `cycleId`) — la SCC existe toujours mais sa
 * protection par gate a basculé.
 */
export interface CycleGatingChange {
  cycleId: string
  nodes: string[]        // path cycle après (ordonné)
  wasGated: boolean
  nowGated: boolean
}

export interface CyclesDiff {
  added: Cycle[]
  removed: Cycle[]
  gatingChanged: CycleGatingChange[]
}

// ─── Typed Calls ────────────────────────────────────────────────────────────

/**
 * Raisons possibles qu'une modif de signature soit « breaking » — un caller
 * existant pourrait casser.
 *
 * - `param-removed`    : nombre de params a diminué.
 * - `param-required`   : un param optional est devenu required.
 * - `return-changed`   : type de retour texte différent (approximation
 *                        structurelle — un type narrowing strict est un
 *                        cas particulier, non différencié v1).
 * - `param-type-changed` : un type de param a changé (texte différent).
 *
 * Un ajout de param optional ou un élargissement de retour ne déclenche
 * pas breaking — c'est explicite dans la règle de matching.
 */
export type BreakingReason =
  | 'param-removed'
  | 'param-required'
  | 'return-changed'
  | 'param-type-changed'

export interface SignatureChange {
  file: string
  exportName: string
  before: { params: Array<{ name: string; type: string; optional: boolean }>; returnType: string }
  after: { params: Array<{ name: string; type: string; optional: boolean }>; returnType: string }
  breaking: boolean
  breakingReasons: BreakingReason[]
}

export interface TypedCallsDiff {
  addedSignatures: TypedSignature[]
  removedSignatures: TypedSignature[]
  modifiedSignatures: SignatureChange[]
  /**
   * Les call edges changent sans arrêt (types inférés qui shiftent, lignes
   * qui bougent) — lister chacun serait explosif et bruyant. On ne garde
   * que les compteurs agrégés pour détecter les grosses bascules.
   */
  callEdgesAdded: number
  callEdgesRemoved: number
}

// ─── State Machines ─────────────────────────────────────────────────────────

export interface StateMachineChange {
  concept: string
  statesAdded: string[]
  statesRemoved: string[]
  orphansAdded: string[]
  orphansResolved: string[]
  deadAdded: string[]
  deadResolved: string[]
  transitionsAdded: StateTransition[]
  transitionsRemoved: StateTransition[]
}

export interface StateMachinesDiff {
  added: StateMachine[]
  removed: StateMachine[]
  changed: StateMachineChange[]
}

// ─── Truth Points ───────────────────────────────────────────────────────────

/**
 * Un concept dont la vérité a bougé. On liste les deltas par catégorie
 * (mirror/writer/reader/exposed) + un champ `canonical` ternaire pour
 * distinguer none→table, table→none, et déplacement de table.
 */
export interface TruthPointChange {
  concept: string
  canonicalBefore: string | null
  canonicalAfter: string | null
  mirrorsAdded: TruthMirror[]
  mirrorsRemoved: TruthMirror[]
  writersAdded: TruthRef[]
  writersRemoved: TruthRef[]
  readersAdded: TruthRef[]
  readersRemoved: TruthRef[]
  exposedAdded: TruthExposure[]
  exposedRemoved: TruthExposure[]
}

export interface TruthPointsDiff {
  added: TruthPoint[]
  removed: TruthPoint[]
  changed: TruthPointChange[]
}

// ─── Data Flows ─────────────────────────────────────────────────────────────

export interface DataFlowChange {
  entryId: string
  entryKind: string
  file: string
  sinksAdded: DataFlowSink[]
  sinksRemoved: DataFlowSink[]
  stepCountBefore: number
  stepCountAfter: number
}

export interface DataFlowsDiff {
  added: DataFlowEntry[]
  removed: DataFlowEntry[]
  changed: DataFlowChange[]
}

// ─── Summary + top-level ────────────────────────────────────────────────────

export interface StructuralDiffSummary {
  cyclesAdded: number
  cyclesRemoved: number
  cyclesGatingChanged: number
  signaturesAdded: number
  signaturesRemoved: number
  signaturesModified: number
  signaturesBreaking: number
  callEdgesAdded: number
  callEdgesRemoved: number
  fsmsAdded: number
  fsmsRemoved: number
  fsmsChanged: number
  truthPointsAdded: number
  truthPointsRemoved: number
  truthPointsChanged: number
  flowsAdded: number
  flowsRemoved: number
  flowsChanged: number
}

export interface StructuralDiff {
  /** Commit hash du before (tronqué si dispo). */
  fromCommit?: string
  /** Commit hash du after (tronqué si dispo). */
  toCommit?: string
  generatedAt: string

  cycles: CyclesDiff
  typedCalls: TypedCallsDiff
  stateMachines: StateMachinesDiff
  truthPoints: TruthPointsDiff
  dataFlows: DataFlowsDiff

  summary: StructuralDiffSummary
}
