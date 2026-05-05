import { type SourceFile, Node, SyntaxKind } from 'ts-morph'
import type {
  TaintedVarDeclCandidateFact,
  TaintedVarArgCallCandidateFact,
} from './types.js'

const TAINTED_VARS_SOURCE_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: 'req.body',     re: /^(req|request|ctx\.req)\.body($|\.|\[)/ },
  { kind: 'req.query',    re: /^(req|request|ctx\.req)\.query($|\.|\[)/ },
  { kind: 'req.params',   re: /^(req|request|ctx\.req)\.params($|\.|\[)/ },
  { kind: 'req.headers',  re: /^(req|request|ctx\.req)\.headers($|\.|\[)/ },
  { kind: 'process.argv', re: /^process\.argv($|\.|\[)/ },
  { kind: 'process.env',  re: /^process\.env($|\.|\[)/ },
]

function matchTaintedVarsSource(text: string): string | null {
  const t = text.trim()
  for (const { kind, re } of TAINTED_VARS_SOURCE_PATTERNS) {
    if (re.test(t)) return kind
  }
  return null
}

interface TaintedVarsFnScope {
  fnNode: Node
  fnId: string
  fnName: string
}

function* iterateTaintedVarsFnScopes(sf: SourceFile): Generator<TaintedVarsFnScope> {
  for (const fn of sf.getFunctions()) {
    const name = fn.getName() ?? '(anonymous)'
    yield { fnNode: fn, fnId: `fn:${name}:${fn.getStartLineNumber()}`, fnName: name }
  }
  for (const cls of sf.getClasses()) {
    const className = cls.getName() ?? '(anonymous)'
    for (const method of cls.getMethods()) {
      const name = `${className}.${method.getName()}`
      yield { fnNode: method, fnId: `mth:${name}:${method.getStartLineNumber()}`, fnName: name }
    }
  }
  for (const v of sf.getVariableDeclarations()) {
    const init = v.getInitializer()
    if (!init) continue
    if (!Node.isArrowFunction(init) && !Node.isFunctionExpression(init)) continue
    const name = v.getName()
    yield { fnNode: init, fnId: `arrow:${name}:${v.getStartLineNumber()}`, fnName: name }
  }
}

function readTaintedVarsCalleeText(callee: Node): string | null {
  if (Node.isIdentifier(callee)) return callee.getText()
  if (Node.isPropertyAccessExpression(callee)) return callee.getText()
  return null
}

interface TaintedScopeCtx {
  relPath: string
  fnName: string
  taintedVars: Map<string, string>
  declsOut: TaintedVarDeclCandidateFact[]
}

function extractTaintedDeclsFromBinding(
  nameNode: Node,
  source: string,
  line: number,
  ctx: TaintedScopeCtx,
): void {
  if (!Node.isObjectBindingPattern(nameNode) && !Node.isArrayBindingPattern(nameNode)) return
  for (const elem of nameNode.getElements()) {
    if (!Node.isBindingElement(elem)) continue
    const elemName = elem.getNameNode()
    if (!Node.isIdentifier(elemName)) continue
    ctx.taintedVars.set(elemName.getText(), source)
    ctx.declsOut.push({
      file: ctx.relPath, containingSymbol: ctx.fnName,
      varName: elemName.getText(), line, source,
    })
  }
}

function extractTaintedVarFromVarDecl(
  v: import('ts-morph').VariableDeclaration,
  ctx: TaintedScopeCtx,
): void {
  const init = v.getInitializer()
  if (!init) return
  const source = matchTaintedVarsSource(init.getText())
  if (!source) return
  const nameNode = v.getNameNode()
  const line = v.getStartLineNumber()
  if (Node.isIdentifier(nameNode)) {
    ctx.taintedVars.set(nameNode.getText(), source)
    ctx.declsOut.push({
      file: ctx.relPath, containingSymbol: ctx.fnName,
      varName: nameNode.getText(), line, source,
    })
    return
  }
  extractTaintedDeclsFromBinding(nameNode, source, line, ctx)
}

function collectTaintedVarsForFnScope(
  fnNode: Node,
  fnName: string,
  relPath: string,
  declsOut: TaintedVarDeclCandidateFact[],
): Map<string, string> {
  const ctx: TaintedScopeCtx = {
    relPath, fnName, taintedVars: new Map<string, string>(), declsOut,
  }
  for (const v of fnNode.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    extractTaintedVarFromVarDecl(v, ctx)
  }
  return ctx.taintedVars
}

function recordTaintedArgCalls(
  fnNode: Node,
  fnName: string,
  taintedVars: Map<string, string>,
  relPath: string,
  argCallsOut: TaintedVarArgCallCandidateFact[],
): void {
  for (const call of fnNode.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const calleeText = readTaintedVarsCalleeText(call.getExpression())
    if (!calleeText) continue
    const args = call.getArguments()
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (!Node.isIdentifier(arg)) continue
      const varName = arg.getText()
      const source = taintedVars.get(varName)
      if (!source) continue
      argCallsOut.push({
        file: relPath,
        line: call.getStartLineNumber(),
        callee: calleeText,
        argVarName: varName,
        argIndex: i,
        source,
        containingSymbol: fnName,
      })
    }
  }
}

export function visitTaintedVarsCandidates(
  sf: SourceFile,
  relPath: string,
  declsOut: TaintedVarDeclCandidateFact[],
  argCallsOut: TaintedVarArgCallCandidateFact[],
): void {
  const taintedByFn = new Map<string, Map<string, string>>()
  for (const { fnNode, fnId, fnName } of iterateTaintedVarsFnScopes(sf)) {
    const taintedVars = collectTaintedVarsForFnScope(fnNode, fnName, relPath, declsOut)
    if (taintedVars.size > 0) taintedByFn.set(fnId, taintedVars)
  }
  for (const { fnNode, fnId, fnName } of iterateTaintedVarsFnScopes(sf)) {
    const taintedVars = taintedByFn.get(fnId)
    if (!taintedVars) continue
    recordTaintedArgCalls(fnNode, fnName, taintedVars, relPath, argCallsOut)
  }
}
