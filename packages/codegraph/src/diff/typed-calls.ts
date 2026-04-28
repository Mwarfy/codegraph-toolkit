/**
 * Typed calls diff — phase 3 du PLAN.md.
 *
 * Signature matching par `(file, exportName)`. Trois catégories :
 *   - added    : clé absente du before
 *   - removed  : clé absente du after
 *   - modified : même clé, params ou returnType diffèrent
 *
 * Pour chaque modified, on calcule les `breakingReasons` — raisons qui
 * feraient casser un caller existant :
 *   - `param-removed`      : arity a diminué
 *   - `param-required`     : un param avant optional est devenu required
 *   - `param-type-changed` : un type de param a changé (position par position)
 *   - `return-changed`     : type de retour différent (approximation :
 *                            on ne distingue pas narrowing vs widening
 *                            — le PLAN l'accepte explicitement v1)
 *
 * Les call edges ne sont pas listés individuellement (trop bruyant :
 * chaque shift de ligne dans un fichier produirait des deltas). On ne
 * garde que les compteurs added/removed pour détecter une grande bascule.
 */

import type { GraphSnapshot, TypedSignature, TypedCallEdge } from '../core/types.js'
import type { BreakingReason, SignatureChange, TypedCallsDiff } from './types.js'

function sigKey(s: TypedSignature): string {
  return `${s.file}\u0000${s.exportName}`
}

function paramsEqual(
  a: TypedSignature['params'],
  b: TypedSignature['params'],
): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].name !== b[i].name) return false
    if (a[i].type !== b[i].type) return false
    if (a[i].optional !== b[i].optional) return false
  }
  return true
}

function detectBreakingReasons(
  before: TypedSignature,
  after: TypedSignature,
): BreakingReason[] {
  const reasons: BreakingReason[] = []

  if (after.params.length < before.params.length) {
    reasons.push('param-removed')
  }

  // Position par position sur la zone commune.
  const common = Math.min(before.params.length, after.params.length)
  for (let i = 0; i < common; i++) {
    if (before.params[i].type !== after.params[i].type) {
      if (!reasons.includes('param-type-changed')) reasons.push('param-type-changed')
    }
    if (before.params[i].optional === true && after.params[i].optional === false) {
      if (!reasons.includes('param-required')) reasons.push('param-required')
    }
  }

  // Ajout de param required en queue → breaking.
  for (let i = before.params.length; i < after.params.length; i++) {
    if (after.params[i].optional === false) {
      if (!reasons.includes('param-required')) reasons.push('param-required')
      break
    }
  }

  if (before.returnType !== after.returnType) reasons.push('return-changed')

  return reasons
}

// Matching par identité logique (phase 3.5) — la ligne était dans la
// clé v1 pour distinguer deux call sites A→B dans le même fichier à des
// lignes différentes. Conséquence non voulue : un shift de 1 ligne
// (édition plus haut dans le fichier) faisait disparaître puis
// réapparaître l'edge, gonflant le counter +N/−N de dizaines d'items
// phantom. En phase 3.5 on matche par (from, to) sans ligne — le counter
// perd la granularité "2 call sites distincts dans le même fichier" mais
// gagne le vrai signal des edges ajoutés/supprimés.
function edgeKey(e: TypedCallEdge): string {
  return `${e.from}\u0000${e.to}`
}

export function diffTypedCalls(before: GraphSnapshot, after: GraphSnapshot): TypedCallsDiff {
  const beforeSigs = before.typedCalls?.signatures ?? []
  const afterSigs = after.typedCalls?.signatures ?? []
  const beforeSigMap = new Map(beforeSigs.map((s) => [sigKey(s), s]))
  const afterSigMap = new Map(afterSigs.map((s) => [sigKey(s), s]))

  const addedSignatures: TypedSignature[] = []
  const modifiedSignatures: SignatureChange[] = []
  for (const [key, afterSig] of afterSigMap) {
    const prev = beforeSigMap.get(key)
    if (prev === undefined) {
      addedSignatures.push(afterSig)
      continue
    }
    if (paramsEqual(prev.params, afterSig.params) && prev.returnType === afterSig.returnType) {
      continue  // inchangée
    }
    const reasons = detectBreakingReasons(prev, afterSig)
    modifiedSignatures.push({
      file: afterSig.file,
      exportName: afterSig.exportName,
      before: { params: prev.params, returnType: prev.returnType },
      after: { params: afterSig.params, returnType: afterSig.returnType },
      breaking: reasons.length > 0,
      breakingReasons: reasons,
    })
  }

  const removedSignatures: TypedSignature[] = []
  for (const [key, beforeSig] of beforeSigMap) {
    if (!afterSigMap.has(key)) removedSignatures.push(beforeSig)
  }

  // Call edges — agrégats seuls.
  const beforeEdges = before.typedCalls?.callEdges ?? []
  const afterEdges = after.typedCalls?.callEdges ?? []
  const beforeEdgeSet = new Set(beforeEdges.map(edgeKey))
  const afterEdgeSet = new Set(afterEdges.map(edgeKey))
  let callEdgesAdded = 0
  let callEdgesRemoved = 0
  for (const k of afterEdgeSet) if (!beforeEdgeSet.has(k)) callEdgesAdded++
  for (const k of beforeEdgeSet) if (!afterEdgeSet.has(k)) callEdgesRemoved++

  // Tri déterministe : par (file, exportName).
  const byKey = (a: TypedSignature, b: TypedSignature): number => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    return a.exportName < b.exportName ? -1 : a.exportName > b.exportName ? 1 : 0
  }
  addedSignatures.sort(byKey)
  removedSignatures.sort(byKey)
  modifiedSignatures.sort((a, b) => {
    // Breaking en premier, puis tri stable (file, export).
    if (a.breaking !== b.breaking) return a.breaking ? -1 : 1
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    return a.exportName < b.exportName ? -1 : a.exportName > b.exportName ? 1 : 0
  })

  return {
    addedSignatures,
    removedSignatures,
    modifiedSignatures,
    callEdgesAdded,
    callEdgesRemoved,
  }
}
