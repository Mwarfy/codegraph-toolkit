/**
 * Await-in-loop — `await` dans un for/while/do/forOf direct (pas dans
 * une fn nested).
 *
 * Sequential I/O bottleneck : N requêtes successives au lieu d'un
 * `Promise.all(items.map(...))`. Souvent symptôme d'un design O(N)
 * latence là où O(1) est faisable.
 */

import { type SourceFile, SyntaxKind } from 'ts-morph'
import { findContainingSymbol } from '../../_shared/ast-helpers.js'
import { findEnclosingLoop, type IsExempt } from './_helpers.js'

export interface AwaitInLoopFact {
  file: string
  line: number
  loopKind: string
  containingSymbol: string
}

export function extractAwaitInLoops(
  sf: SourceFile,
  relPath: string,
  isExempt: IsExempt,
): AwaitInLoopFact[] {
  const out: AwaitInLoopFact[] = []

  for (const awaitNode of sf.getDescendantsOfKind(SyntaxKind.AwaitExpression)) {
    const line = awaitNode.getStartLineNumber()
    if (isExempt(line, 'await-ok')) continue
    const loop = findEnclosingLoop(awaitNode)
    if (!loop) continue
    out.push({
      file: relPath,
      line,
      loopKind: SyntaxKind[loop.getKind()] ?? 'unknown',
      containingSymbol: findContainingSymbol(awaitNode),
    })
  }

  return out
}
