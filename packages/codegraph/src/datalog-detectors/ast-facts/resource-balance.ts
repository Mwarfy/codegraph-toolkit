import { type SourceFile, Node, SyntaxKind } from 'ts-morph'
import type { ResourceImbalanceCandidateFact } from './types.js'

interface ResourcePairDef { acquire: string; release: string }

const RESOURCE_PAIRS: ResourcePairDef[] = [
  { acquire: 'acquire', release: 'release' },
  { acquire: 'lock', release: 'unlock' },
  { acquire: 'connect', release: 'disconnect' },
  { acquire: 'open', release: 'close' },
  { acquire: 'subscribe', release: 'unsubscribe' },
  { acquire: 'setInterval', release: 'clearInterval' },
  { acquire: 'addEventListener', release: 'removeEventListener' },
]

interface ResourceFnScope { name: string; body: Node | undefined; line: number }

function* iterateResourceFnScopes(sf: SourceFile): Generator<ResourceFnScope> {
  for (const fn of sf.getFunctions()) {
    yield { name: fn.getName() ?? '(anonymous)', body: fn.getBody(), line: fn.getStartLineNumber() }
  }
  for (const cls of sf.getClasses()) {
    const className = cls.getName() ?? '(anonymous)'
    for (const method of cls.getMethods()) {
      yield {
        name: `${className}.${method.getName()}`,
        body: method.getBody(),
        line: method.getStartLineNumber(),
      }
    }
  }
  for (const v of sf.getVariableDeclarations()) {
    const init = v.getInitializer()
    if (!init) continue
    if (!Node.isArrowFunction(init) && !Node.isFunctionExpression(init)) continue
    yield { name: v.getName(), body: init.getBody(), line: v.getStartLineNumber() }
  }
}

function readResourceCalleeName(callee: Node): string | null {
  if (Node.isIdentifier(callee)) return callee.getText()
  if (Node.isPropertyAccessExpression(callee)) return callee.getName()
  return null
}

export function visitResourceImbalanceCandidates(
  sf: SourceFile,
  relPath: string,
  out: ResourceImbalanceCandidateFact[],
): void {
  for (const scope of iterateResourceFnScopes(sf)) {
    if (!scope.body) continue
    const counts = new Map<string, number>()
    for (const call of scope.body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const methodName = readResourceCalleeName(call.getExpression())
      if (!methodName) continue
      counts.set(methodName, (counts.get(methodName) ?? 0) + 1)
    }
    for (const pair of RESOURCE_PAIRS) {
      const acq = counts.get(pair.acquire) ?? 0
      const rel = counts.get(pair.release) ?? 0
      if (acq === 0 || rel === 0) continue
      if (acq === rel) continue
      out.push({
        file: relPath,
        containingSymbol: scope.name,
        line: scope.line,
        pair: `${pair.acquire}/${pair.release}`,
        acquireCount: acq,
        releaseCount: rel,
      })
    }
  }
}
