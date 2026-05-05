import { type SourceFile, Node, SyntaxKind } from 'ts-morph'
import { findContainingSymbol } from '../../extractors/_shared/ast-helpers.js'
import type { SanitizerCandidateFact } from './types.js'

const SANITIZER_METHODS = new Set<string>([
  'parse', 'safeParse', 'safeParseAsync', 'parseAsync',
  'validate', 'validateSync', 'validateAsync',
  'validateBody', 'validateQuery', 'validateParams', 'validateInput',
  'validateRequest', 'validateSchema',
  'escape', 'escapeHtml', 'sanitize', 'sanitizeHtml', 'sanitizeUrl',
  'normalize', 'resolve',
  'encodeURIComponent', 'encodeURI',
])
const SANITIZER_NAME_PREFIXES = /^(validate|sanitize|clean|escape|normalize|verify|check|parse)/i

export function visitSanitizerCandidates(
  sf: SourceFile,
  relPath: string,
  out: SanitizerCandidateFact[],
): void {
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression()
    let methodName: string | null = null
    let calleeText = ''
    if (Node.isIdentifier(callee)) {
      methodName = callee.getText()
      calleeText = methodName
    } else if (Node.isPropertyAccessExpression(callee)) {
      methodName = callee.getName()
      calleeText = callee.getText()
    } else continue
    if (!methodName) continue
    if (!SANITIZER_METHODS.has(methodName) && !SANITIZER_NAME_PREFIXES.test(methodName)) continue
    out.push({
      file: relPath,
      line: call.getStartLineNumber(),
      callee: calleeText,
      containingSymbol: findContainingSymbol(call),
    })
  }
}
