/**
 * Allocation-in-loop — capture les allocations synthétisées à chaque
 * itération d'une boucle directe : `[]`, `{}`, `new X(...)`.
 *
 * GC pressure marker : N itérations × allocation = N objects à collecter.
 * Pour les hot paths, hoister hors du loop ou réutiliser un pool.
 *
 * Filtres FP :
 *   - L'allocation EST le iterable du loop (`for (const x of [...])`) →
 *     évaluée 1 fois, pas N.
 *   - L'allocation est dans un `TypeReference` (parsing artifact pour des
 *     types inline) → pas une allocation runtime.
 */

import { type SourceFile, type Node, SyntaxKind } from 'ts-morph'
import { findContainingSymbol } from '../../_shared/ast-helpers.js'
import {
  FN_KINDS,
  LOOP_KINDS,
  isDescendantOfLoopInit,
  type IsExempt,
} from './_helpers.js'

export interface AllocationInLoopFact {
  file: string
  line: number
  /** Kind d'allocation : 'array-literal' | 'object-literal' | 'new-expression' */
  allocKind: string
  containingSymbol: string
}

const ALLOC_CANDIDATES: ReadonlyArray<{ kind: SyntaxKind; alias: string }> = [
  { kind: SyntaxKind.ArrayLiteralExpression, alias: 'array-literal' },
  { kind: SyntaxKind.ObjectLiteralExpression, alias: 'object-literal' },
  { kind: SyntaxKind.NewExpression, alias: 'new-expression' },
]

export function extractAllocationInLoops(
  sf: SourceFile,
  relPath: string,
  isExempt: IsExempt,
): AllocationInLoopFact[] {
  const out: AllocationInLoopFact[] = []
  for (const candidate of ALLOC_CANDIDATES) {
    for (const node of sf.getDescendantsOfKind(candidate.kind)) {
      const fact = analyzeAllocCandidate(node, relPath, candidate.alias, isExempt)
      if (fact) out.push(fact)
    }
  }
  return out
}

function analyzeAllocCandidate(
  node: Node,
  relPath: string,
  alias: string,
  isExempt: IsExempt,
): AllocationInLoopFact | null {
  const line = node.getStartLineNumber()
  if (isExempt(line, 'alloc-ok')) return null

  const loopAncestor = findEnclosingLoop(node)
  if (!loopAncestor) return null

  // FP : ObjectLiteral dans un TypeNode (parsing artifact pour types inline).
  if (alias === 'object-literal' && node.getFirstAncestorByKind(SyntaxKind.TypeReference)) {
    return null
  }
  // FP : l'allocation EST l'init/condition/incrementor du loop, pas par-iteration.
  if (isDescendantOfLoopInit(node, loopAncestor)) return null

  return {
    file: relPath,
    line,
    allocKind: alias,
    containingSymbol: findContainingSymbol(node),
  }
}

/** Trouve le premier loop ancestor en s'arrêtant à toute fn nested. */
function findEnclosingLoop(node: Node): Node | undefined {
  let cur: Node | undefined = node.getParent()
  while (cur) {
    if (FN_KINDS.has(cur.getKind())) return undefined
    if (LOOP_KINDS.has(cur.getKind())) return cur
    cur = cur.getParent()
  }
  return undefined
}
