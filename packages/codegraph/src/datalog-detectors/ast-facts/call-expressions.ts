import { type SourceFile, Node, SyntaxKind } from 'ts-morph'
import { findContainingSymbol } from '../../extractors/_shared/ast-helpers.js'
import type { CallExpressionFact } from './types.js'

function buildCallFact(
  call: import('ts-morph').CallExpression | import('ts-morph').NewExpression,
  relPath: string,
  isNew: number,
): CallExpressionFact {
  const callee = call.getExpression()
  let calleeKind: CallExpressionFact['calleeKind'] = 'Other'
  let calleeName = ''
  let calleeObjectLast = ''
  if (Node.isIdentifier(callee)) {
    calleeKind = 'Identifier'
    calleeName = callee.getText()
  } else if (Node.isPropertyAccessExpression(callee)) {
    calleeKind = 'PropertyAccess'
    calleeName = callee.getName()
    const obj = callee.getExpression()
    const objText = obj.getText()
    const last = (objText.split('.').pop() ?? '').toLowerCase()
    calleeObjectLast = last
  }

  let firstArgKind: CallExpressionFact['firstArgKind'] = 'other'
  let firstArgValue = ''
  const args = call.getArguments?.() ?? []
  if (args.length > 0) {
    const a = args[0]
    if (Node.isStringLiteral(a) || Node.isNoSubstitutionTemplateLiteral(a)) {
      firstArgKind = 'string'
      firstArgValue = a.getLiteralValue().toLowerCase()
    } else if (Node.isNumericLiteral(a)) {
      firstArgKind = 'number'
      firstArgValue = a.getText()
    } else if (a.getKind() === SyntaxKind.TrueKeyword || a.getKind() === SyntaxKind.FalseKeyword) {
      firstArgKind = 'boolean'
      firstArgValue = a.getText()
    }
  }

  return {
    file: relPath,
    line: call.getStartLineNumber(),
    calleeKind,
    calleeName,
    calleeObjectLast,
    firstArgKind,
    firstArgValue,
    isNew,
    containingSymbol: findContainingSymbol(call),
  }
}

export function visitCallAndNewExpressions(
  sf: SourceFile,
  relPath: string,
  out: CallExpressionFact[],
): void {
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    out.push(buildCallFact(call, relPath, /*isNew*/ 0))
  }
  for (const newExpr of sf.getDescendantsOfKind(SyntaxKind.NewExpression)) {
    out.push(buildCallFact(newExpr, relPath, /*isNew*/ 1))
  }
}
