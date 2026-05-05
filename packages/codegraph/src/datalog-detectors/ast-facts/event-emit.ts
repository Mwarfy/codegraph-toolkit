import { type SourceFile, Node, SyntaxKind } from 'ts-morph'
import { buildLineToSymbol } from '../../extractors/_shared/ast-helpers.js'
import type { EventEmitSiteCandidateFact } from './types.js'

const EMIT_NAMES = new Set(['emit', 'emitEvent'])

interface EmitCalleeInfo { calleeName: string; isMethodCall: number; receiver: string }

function parseEmitCalleeInfo(callee: Node): EmitCalleeInfo | null {
  if (Node.isIdentifier(callee)) {
    return { calleeName: callee.getText(), isMethodCall: 0, receiver: '' }
  }
  if (Node.isPropertyAccessExpression(callee)) {
    return {
      calleeName: callee.getName(),
      isMethodCall: 1,
      receiver: callee.getExpression().getText(),
    }
  }
  return null
}

function findTypePropInitializer(obj: import('ts-morph').ObjectLiteralExpression): Node | undefined {
  for (const p of obj.getProperties()) {
    if (p.getKind() !== SyntaxKind.PropertyAssignment) continue
    const pa = p as import('ts-morph').PropertyAssignment
    const nameNode = pa.getNameNode()
    const k = nameNode.getKind()
    let name: string | undefined
    if (k === SyntaxKind.Identifier) name = nameNode.getText()
    else if (k === SyntaxKind.StringLiteral) {
      name = (nameNode as import('ts-morph').StringLiteral).getLiteralText()
    }
    if (name === 'type') return pa.getInitializer()
  }
  return undefined
}

function buildEmitFactFromTypeInit(
  typeInit: Node,
  relPath: string,
  line: number,
  symbol: string,
  info: EmitCalleeInfo,
): EventEmitSiteCandidateFact {
  const initKind = typeInit.getKind()
  const base = {
    file: relPath, line, symbol,
    callee: info.calleeName, isMethodCall: info.isMethodCall, receiver: info.receiver,
  }
  if (initKind === SyntaxKind.StringLiteral || initKind === SyntaxKind.NoSubstitutionTemplateLiteral) {
    const lit = typeInit as import('ts-morph').StringLiteral | import('ts-morph').NoSubstitutionTemplateLiteral
    return { ...base, kind: 'literal', literalValue: lit.getLiteralText(), refExpression: '' }
  }
  if (initKind === SyntaxKind.PropertyAccessExpression) {
    return { ...base, kind: 'eventConstRef', literalValue: '', refExpression: typeInit.getText() }
  }
  return { ...base, kind: 'dynamic', literalValue: '', refExpression: '' }
}

export function visitEventEmitSiteCandidates(
  sf: SourceFile,
  relPath: string,
  out: EventEmitSiteCandidateFact[],
): void {
  const text = sf.getFullText()
  let hasCandidate = false
  for (const n of EMIT_NAMES) {
    if (text.includes(n + '(')) { hasCandidate = true; break }
  }
  if (!hasCandidate) return

  const lineToSymbol = buildLineToSymbol(sf)
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callInfo = parseEmitCalleeInfo(call.getExpression())
    if (!callInfo || !EMIT_NAMES.has(callInfo.calleeName)) continue

    const args = call.getArguments()
    if (args.length === 0) continue
    const firstArg = args[0]
    if (firstArg.getKind() !== SyntaxKind.ObjectLiteralExpression) continue

    const typeInit = findTypePropInitializer(firstArg as import('ts-morph').ObjectLiteralExpression)
    if (!typeInit) continue

    const line = call.getStartLineNumber()
    const symbol = lineToSymbol.get(line) ?? ''
    out.push(buildEmitFactFromTypeInit(typeInit, relPath, line, symbol, callInfo))
  }
}
