import { type SourceFile, Node, SyntaxKind } from 'ts-morph'
import type { NumericLiteralFact } from './types.js'

const SCREAMING_SNAKE_RE = /^[A-Z][A-Z0-9_]*$/
const TRIVIAL_VALUES = new Set<number>([0, 1, -1, 2, 100, 1000])
const COMPARISON_OPS_FOR_MAGIC = new Set<string>([
  '>', '<', '>=', '<=', '===', '==', '!==', '!=',
])

interface ParentClassification {
  parentKind: NumericLiteralFact['parentKind']
  parentName: string
  parentArgIdx: number
  isScreamingSnake: number
}

function getCalleeName(expr: Node): string | null {
  if (Node.isIdentifier(expr)) return expr.getText()
  if (Node.isPropertyAccessExpression(expr)) return expr.getName()
  return null
}

function classifyNumericLiteralParent(parent: Node, lit: Node): ParentClassification {
  if (Node.isCallExpression(parent)) {
    return {
      parentKind: 'CallExpression',
      parentName: getCalleeName(parent.getExpression()) ?? '',
      parentArgIdx: parent.getArguments().findIndex((a) => a === lit),
      isScreamingSnake: 0,
    }
  }
  if (Node.isPropertyAssignment(parent)) {
    return {
      parentKind: 'PropertyAssignment',
      parentName: parent.getName(),
      parentArgIdx: -1,
      isScreamingSnake: 0,
    }
  }
  if (Node.isVariableDeclaration(parent)) {
    const name = parent.getName()
    return {
      parentKind: 'VariableDeclaration',
      parentName: name,
      parentArgIdx: -1,
      isScreamingSnake: SCREAMING_SNAKE_RE.test(name) ? 1 : 0,
    }
  }
  if (Node.isBinaryExpression(parent)) {
    const op = parent.getOperatorToken().getText()
    if (COMPARISON_OPS_FOR_MAGIC.has(op)) {
      return {
        parentKind: 'BinaryExpression',
        parentName: `compare ${op}`,
        parentArgIdx: -1,
        isScreamingSnake: 0,
      }
    }
  }
  return { parentKind: 'Other', parentName: '', parentArgIdx: -1, isScreamingSnake: 0 }
}

export function visitNumericLiterals(
  sf: SourceFile,
  relPath: string,
  out: NumericLiteralFact[],
): void {
  for (const lit of sf.getDescendantsOfKind(SyntaxKind.NumericLiteral)) {
    const text = lit.getText()
    const value = parseFloat(text.replace(/_/g, ''))
    if (!Number.isFinite(value)) continue
    const parent = lit.getParent()
    if (!parent) continue

    const cls = classifyNumericLiteralParent(parent, lit)

    out.push({
      file: relPath,
      line: lit.getStartLineNumber(),
      valueText: text,
      valueAbs: Math.trunc(Math.abs(value)),
      parentKind: cls.parentKind,
      parentName: cls.parentName,
      parentArgIdx: cls.parentArgIdx,
      isScreamingSnake: cls.isScreamingSnake,
      isRatio: value > 0 && value < 1 ? 1 : 0,
      isTrivial: TRIVIAL_VALUES.has(value) ? 1 : 0,
    })
  }
}
