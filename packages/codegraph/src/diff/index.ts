/**
 * Structural diff orchestrator — phase 3 du PLAN.md.
 *
 * Compose les 5 diffs de section + produit le résumé agrégé.
 * Pur et déterministe — mêmes inputs → même JSON.
 */

import type { GraphSnapshot } from '../core/types.js'
import type { StructuralDiff, StructuralDiffSummary } from './types.js'
import { diffCycles } from './cycles.js'
import { diffTypedCalls } from './typed-calls.js'
import { diffStateMachines } from './state-machines.js'
import { diffTruthPoints } from './truth-points.js'
import { diffDataFlows } from './data-flows.js'

export * from './types.js'
export { renderStructuralDiffMarkdown } from './renderer.js'

export function buildStructuralDiff(
  before: GraphSnapshot,
  after: GraphSnapshot,
): StructuralDiff {
  const cycles = diffCycles(before, after)
  const typedCalls = diffTypedCalls(before, after)
  const stateMachines = diffStateMachines(before, after)
  const truthPoints = diffTruthPoints(before, after)
  const dataFlows = diffDataFlows(before, after)

  const summary: StructuralDiffSummary = {
    cyclesAdded: cycles.added.length,
    cyclesRemoved: cycles.removed.length,
    cyclesGatingChanged: cycles.gatingChanged.length,
    signaturesAdded: typedCalls.addedSignatures.length,
    signaturesRemoved: typedCalls.removedSignatures.length,
    signaturesModified: typedCalls.modifiedSignatures.length,
    signaturesBreaking: typedCalls.modifiedSignatures.filter((m) => m.breaking).length,
    callEdgesAdded: typedCalls.callEdgesAdded,
    callEdgesRemoved: typedCalls.callEdgesRemoved,
    fsmsAdded: stateMachines.added.length,
    fsmsRemoved: stateMachines.removed.length,
    fsmsChanged: stateMachines.changed.length,
    truthPointsAdded: truthPoints.added.length,
    truthPointsRemoved: truthPoints.removed.length,
    truthPointsChanged: truthPoints.changed.length,
    flowsAdded: dataFlows.added.length,
    flowsRemoved: dataFlows.removed.length,
    flowsChanged: dataFlows.changed.length,
  }

  return {
    fromCommit: before.commitHash,
    toCommit: after.commitHash,
    generatedAt: new Date().toISOString(),
    cycles,
    typedCalls,
    stateMachines,
    truthPoints,
    dataFlows,
    summary,
  }
}
