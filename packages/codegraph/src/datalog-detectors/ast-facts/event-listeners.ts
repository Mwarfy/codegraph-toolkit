import { type SourceFile, Node, SyntaxKind } from 'ts-morph'
import { findContainingSymbol } from '../../extractors/_shared/ast-helpers.js'
import type { EventListenerSiteCandidateFact } from './types.js'

const EVENT_LISTENER_NAMES = new Set([
  'on', 'once', 'subscribe', 'addEventListener', 'listen', 'listensTo',
])

export function visitEventListenerSiteCandidates(
  sf: SourceFile,
  relPath: string,
  out: EventListenerSiteCandidateFact[],
): void {
  const text = sf.getFullText()
  let hasCandidate = false
  for (const n of EVENT_LISTENER_NAMES) {
    if (text.includes(n + '(') || text.includes('.' + n + '(')) {
      hasCandidate = true
      break
    }
  }
  if (!hasCandidate) return

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression()
    let calleeName = ''
    let isMethodCall = 0
    let receiver = ''
    if (Node.isIdentifier(callee)) {
      calleeName = callee.getText()
    } else if (Node.isPropertyAccessExpression(callee)) {
      calleeName = callee.getName()
      isMethodCall = 1
      receiver = callee.getExpression().getText()
    } else continue
    if (!EVENT_LISTENER_NAMES.has(calleeName)) continue

    const args = call.getArguments()
    if (args.length === 0) continue
    const arg0 = args[0]
    const line = call.getStartLineNumber()
    const symbol = findContainingSymbol(call)
    const fullCalleeText = isMethodCall === 1 && receiver
      ? `${receiver}.${calleeName}` : calleeName

    if (Node.isStringLiteral(arg0) || Node.isNoSubstitutionTemplateLiteral(arg0)) {
      out.push({
        file: relPath, line, symbol, callee: fullCalleeText,
        isMethodCall, receiver,
        kind: 'literal', literalValue: arg0.getLiteralValue(), refExpression: '',
      })
    } else if (Node.isPropertyAccessExpression(arg0)) {
      out.push({
        file: relPath, line, symbol, callee: fullCalleeText,
        isMethodCall, receiver,
        kind: 'eventConstRef', literalValue: '', refExpression: arg0.getText(),
      })
    } else {
      out.push({
        file: relPath, line, symbol, callee: fullCalleeText,
        isMethodCall, receiver,
        kind: 'dynamic', literalValue: '', refExpression: '',
      })
    }
  }
}
