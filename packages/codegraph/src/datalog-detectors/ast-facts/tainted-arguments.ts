import { type SourceFile, Node, SyntaxKind } from 'ts-morph'
import type { TaintedArgumentCandidateFact } from './types.js'

type TaintSourceKindStr =
  | 'req.body' | 'req.query' | 'req.params' | 'req.headers'
  | 'process.argv' | 'process.env'

const ARG_SOURCE_PATTERNS: Array<{ kind: TaintSourceKindStr; re: RegExp }> = [
  { kind: 'req.body',     re: /^(req|request|ctx\.req)\.body($|\.|\[)/ },
  { kind: 'req.query',    re: /^(req|request|ctx\.req)\.query($|\.|\[)/ },
  { kind: 'req.params',   re: /^(req|request|ctx\.req)\.params($|\.|\[)/ },
  { kind: 'req.headers',  re: /^(req|request|ctx\.req)\.headers($|\.|\[)/ },
  { kind: 'process.argv', re: /^process\.argv($|\.|\[)/ },
  { kind: 'process.env',  re: /^process\.env($|\.|\[)/ },
]

function matchArgSource(text: string): TaintSourceKindStr | null {
  const t = text.trim()
  for (const { kind, re } of ARG_SOURCE_PATTERNS) {
    if (re.test(t)) return kind
  }
  return null
}

interface ArgFnScope {
  name: string
  fnNode: Node
}

function* iterateArgFnScopes(sf: SourceFile): Generator<ArgFnScope> {
  for (const fn of sf.getFunctions()) {
    const name = fn.getName()
    if (!name) continue
    yield { name, fnNode: fn }
  }
  for (const cls of sf.getClasses()) {
    const className = cls.getName() ?? '(anonymous)'
    for (const method of cls.getMethods()) {
      yield { name: `${className}.${method.getName()}`, fnNode: method }
    }
  }
  for (const v of sf.getVariableDeclarations()) {
    const init = v.getInitializer()
    if (!init) continue
    if (!Node.isArrowFunction(init) && !Node.isFunctionExpression(init)) continue
    yield { name: v.getName(), fnNode: init }
  }
}

function collectArgScopeTaintedVars(fnNode: Node): Map<string, TaintSourceKindStr> {
  const taintedVars = new Map<string, TaintSourceKindStr>()
  for (const v of fnNode.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = v.getInitializer()
    if (!init) continue
    const src = matchArgSource(init.getText())
    if (!src) continue
    const nameNode = v.getNameNode()
    if (!Node.isIdentifier(nameNode)) continue
    taintedVars.set(nameNode.getText(), src)
  }
  return taintedVars
}

function readArgCalleeText(callee: Node): string | null {
  if (Node.isIdentifier(callee)) return callee.getText()
  if (Node.isPropertyAccessExpression(callee)) return callee.getName()
  return null
}

export function visitTaintedArgumentCandidates(
  sf: SourceFile,
  relPath: string,
  out: TaintedArgumentCandidateFact[],
): void {
  for (const scope of iterateArgFnScopes(sf)) {
    const taintedVars = collectArgScopeTaintedVars(scope.fnNode)
    for (const call of scope.fnNode.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const calleeText = readArgCalleeText(call.getExpression())
      if (!calleeText) continue
      const args = call.getArguments()
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        const directSrc = matchArgSource(arg.getText())
        if (directSrc) {
          out.push({
            callerFile: relPath, callerSymbol: scope.name,
            callee: calleeText, paramIndex: i, source: directSrc,
          })
          continue
        }
        if (Node.isIdentifier(arg)) {
          const varSrc = taintedVars.get(arg.getText())
          if (varSrc) {
            out.push({
              callerFile: relPath, callerSymbol: scope.name,
              callee: calleeText, paramIndex: i, source: varSrc,
            })
          }
        }
      }
    }
  }
}
