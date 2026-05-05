import { type SourceFile, Node, SyntaxKind } from 'ts-morph'
import type { ConstantExpressionCandidateFact } from './types.js'

const CONST_EXPR_EQ_NEQ_OPS = new Set<SyntaxKind>([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
])

type BoolVerdict = 'always-true' | 'always-false' | 'unknown'

function classifyConstExprLiteralBool(node: Node): BoolVerdict {
  const k = node.getKind()
  if (k === SyntaxKind.TrueKeyword) return 'always-true'
  if (k === SyntaxKind.FalseKeyword) return 'always-false'
  if (Node.isNumericLiteral(node)) {
    return parseFloat(node.getText()) === 0 ? 'always-false' : 'always-true'
  }
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralText().length === 0 ? 'always-false' : 'always-true'
  }
  return 'unknown'
}

function classifyConstExprAndOr(
  node: import('ts-morph').BinaryExpression,
): BoolVerdict {
  const op = node.getOperatorToken().getKind()
  if (op !== SyntaxKind.AmpersandAmpersandToken && op !== SyntaxKind.BarBarToken) {
    return 'unknown'
  }
  const l = classifyConstExprBool(node.getLeft())
  const r = classifyConstExprBool(node.getRight())
  if (op === SyntaxKind.AmpersandAmpersandToken) {
    if (l === 'always-false' || r === 'always-false') return 'always-false'
    if (l === 'always-true' && r === 'always-true') return 'always-true'
    return 'unknown'
  }
  if (l === 'always-true' || r === 'always-true') return 'always-true'
  if (l === 'always-false' && r === 'always-false') return 'always-false'
  return 'unknown'
}

function classifyConstExprNegation(
  node: import('ts-morph').PrefixUnaryExpression,
): BoolVerdict {
  if (node.getOperatorToken() !== SyntaxKind.ExclamationToken) return 'unknown'
  const inner = classifyConstExprBool(node.getOperand())
  if (inner === 'always-true') return 'always-false'
  if (inner === 'always-false') return 'always-true'
  return 'unknown'
}

function classifyConstExprBool(node: Node): BoolVerdict {
  const lit = classifyConstExprLiteralBool(node)
  if (lit !== 'unknown') return lit
  if (Node.isBinaryExpression(node)) return classifyConstExprAndOr(node)
  if (Node.isPrefixUnaryExpression(node)) return classifyConstExprNegation(node)
  return 'unknown'
}

function isConstExprBoolLiteral(node: Node): boolean {
  const k = node.getKind()
  return k === SyntaxKind.TrueKeyword || k === SyntaxKind.FalseKeyword
}

function isConstExprZeroLiteral(node: Node): boolean {
  if (!Node.isNumericLiteral(node)) return false
  return parseFloat(node.getText()) === 0
}

function isConstExprDoubleNegContextOk(parent: Node | undefined): boolean {
  if (!parent) return false
  return Node.isReturnStatement(parent)
    || Node.isAsExpression(parent)
    || Node.isVariableDeclaration(parent)
}

function truncateConstExpr(s: string, max = 80): string {
  const oneline = s.replace(/\s+/g, ' ').trim()
  return oneline.length <= max ? oneline : oneline.slice(0, max - 3) + '...'
}

function pushConstExprConditionFinding(
  cond: Node,
  line: number,
  relPath: string,
  ctx: 'if' | 'ternary',
  out: ConstantExpressionCandidateFact[],
): void {
  const verdict = classifyConstExprBool(cond)
  if (verdict === 'always-true') {
    out.push({
      file: relPath, line,
      kind: 'tautology-condition',
      message: ctx === 'if'
        ? 'if condition always true — else branch unreachable'
        : 'ternary condition always true — only "then" branch reachable',
      exprRepr: truncateConstExpr(cond.getText()),
    })
  } else if (verdict === 'always-false') {
    out.push({
      file: relPath, line,
      kind: 'contradiction-condition',
      message: ctx === 'if'
        ? 'if condition always false — then branch unreachable'
        : 'ternary condition always false — only "else" branch reachable',
      exprRepr: truncateConstExpr(cond.getText()),
    })
  }
}

function findTautologyContradiction(
  sf: SourceFile, relPath: string, out: ConstantExpressionCandidateFact[],
): void {
  for (const ifNode of sf.getDescendantsOfKind(SyntaxKind.IfStatement)) {
    pushConstExprConditionFinding(
      ifNode.getExpression(), ifNode.getStartLineNumber(), relPath, 'if', out,
    )
  }
  for (const tern of sf.getDescendantsOfKind(SyntaxKind.ConditionalExpression)) {
    pushConstExprConditionFinding(
      tern.getCondition(), tern.getStartLineNumber(), relPath, 'ternary', out,
    )
  }
}

function findGratuitousBoolComparison(
  sf: SourceFile, relPath: string, out: ConstantExpressionCandidateFact[],
): void {
  for (const bin of sf.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (!CONST_EXPR_EQ_NEQ_OPS.has(bin.getOperatorToken().getKind())) continue
    if (!isConstExprBoolLiteral(bin.getLeft()) && !isConstExprBoolLiteral(bin.getRight())) continue
    out.push({
      file: relPath,
      line: bin.getStartLineNumber(),
      kind: 'gratuitous-bool-comparison',
      message: 'comparison with true/false literal — compare boolean directly',
      exprRepr: truncateConstExpr(bin.getText()),
    })
  }
}

function findDoubleNegation(
  sf: SourceFile, relPath: string, out: ConstantExpressionCandidateFact[],
): void {
  for (const prefix of sf.getDescendantsOfKind(SyntaxKind.PrefixUnaryExpression)) {
    if (prefix.getOperatorToken() !== SyntaxKind.ExclamationToken) continue
    const inner = prefix.getOperand()
    if (!Node.isPrefixUnaryExpression(inner)) continue
    if (inner.getOperatorToken() !== SyntaxKind.ExclamationToken) continue
    if (isConstExprDoubleNegContextOk(prefix.getParent())) continue
    out.push({
      file: relPath,
      line: prefix.getStartLineNumber(),
      kind: 'double-negation',
      message: '!! gratuitous in boolean context — use directly',
      exprRepr: truncateConstExpr(prefix.getText()),
    })
  }
}

function findLiteralFoldOpportunity(
  sf: SourceFile, relPath: string, out: ConstantExpressionCandidateFact[],
): void {
  for (const bin of sf.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (bin.getOperatorToken().getKind() !== SyntaxKind.PlusToken) continue
    if (!isConstExprZeroLiteral(bin.getLeft()) && !isConstExprZeroLiteral(bin.getRight())) continue
    out.push({
      file: relPath,
      line: bin.getStartLineNumber(),
      kind: 'literal-fold-opportunity',
      message: 'addition with 0 — no-op, can simplify',
      exprRepr: truncateConstExpr(bin.getText()),
    })
  }
}

export function visitConstantExpressionCandidates(
  sf: SourceFile,
  relPath: string,
  out: ConstantExpressionCandidateFact[],
): void {
  findTautologyContradiction(sf, relPath, out)
  findGratuitousBoolComparison(sf, relPath, out)
  findDoubleNegation(sf, relPath, out)
  findLiteralFoldOpportunity(sf, relPath, out)
}
