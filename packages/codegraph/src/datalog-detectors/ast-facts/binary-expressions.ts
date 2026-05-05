import { type SourceFile, SyntaxKind } from 'ts-morph'
import type { BinaryExpressionFact } from './types.js'

const SHORT_LITERAL_RE = /^[\d"'`]/
const SHORT_LITERAL_MAX_LEN = 4

export function visitBinaryExpressions(
  sf: SourceFile,
  relPath: string,
  out: BinaryExpressionFact[],
): void {
  for (const expr of sf.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    const op = expr.getOperatorToken().getText()
    const leftText = expr.getLeft().getText().trim()
    const rightText = expr.getRight().getText().trim()
    const leftIsShortLiteral =
      SHORT_LITERAL_RE.test(leftText) && leftText.length < SHORT_LITERAL_MAX_LEN ? 1 : 0
    out.push({
      file: relPath,
      line: expr.getStartLineNumber(),
      op,
      leftText,
      rightText,
      leftIsShortLiteral,
    })
  }
}
