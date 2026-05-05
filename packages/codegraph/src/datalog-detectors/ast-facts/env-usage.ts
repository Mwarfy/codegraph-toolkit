import { type SourceFile, Node, SyntaxKind } from 'ts-morph'
import { buildLineToSymbol } from '../../extractors/_shared/ast-helpers.js'
import type { EnvVarReadFact } from './types.js'

const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/

function isProcessEnvNode(node: Node): boolean {
  if (!Node.isPropertyAccessExpression(node)) return false
  const left = node.getExpression()
  const right = node.getName()
  if (right !== 'env') return false
  if (!Node.isIdentifier(left)) return false
  return left.getText() === 'process'
}

function envParentHasDefault(node: Node): number {
  const parent = node.getParent()
  if (!parent || !Node.isBinaryExpression(parent)) return 0
  const op = parent.getOperatorToken().getKind()
  if (op !== SyntaxKind.QuestionQuestionToken && op !== SyntaxKind.BarBarToken) return 0
  return parent.getLeft() === node ? 1 : 0
}

function envWrappingCallName(node: Node): string {
  let target: Node = node
  const direct = target.getParent()
  if (direct && Node.isBinaryExpression(direct)) {
    const op = direct.getOperatorToken().getKind()
    if ((op === SyntaxKind.QuestionQuestionToken || op === SyntaxKind.BarBarToken)
        && direct.getLeft() === target) {
      target = direct
    }
  }
  const parent = target.getParent()
  if (!parent || !Node.isCallExpression(parent)) return ''
  if (!parent.getArguments().includes(target as never)) return ''
  const callee = parent.getExpression()
  if (Node.isIdentifier(callee)) return callee.getText()
  if (Node.isPropertyAccessExpression(callee)) return callee.getName()
  return ''
}

function tryEmitEnvFromPropertyAccess(
  node: Node,
  relPath: string,
  lineToSymbol: Map<number, string>,
  out: EnvVarReadFact[],
): void {
  const pa = node as import('ts-morph').PropertyAccessExpression
  if (!isProcessEnvNode(pa.getExpression())) return
  const name = pa.getName()
  if (!name || !ENV_NAME_RE.test(name) || name.length < 2) return
  const line = node.getStartLineNumber()
  out.push({
    file: relPath,
    line,
    col: node.getStart(),
    varName: name,
    symbol: lineToSymbol.get(line) ?? '',
    hasDefault: envParentHasDefault(node),
    wrappedIn: envWrappingCallName(node),
  })
}

function tryEmitEnvFromElementAccess(
  node: Node,
  relPath: string,
  lineToSymbol: Map<number, string>,
  out: EnvVarReadFact[],
): void {
  const ea = node as import('ts-morph').ElementAccessExpression
  if (!isProcessEnvNode(ea.getExpression())) return
  const arg = ea.getArgumentExpression()
  if (!arg) return
  if (!Node.isStringLiteral(arg) && !Node.isNoSubstitutionTemplateLiteral(arg)) return
  const name = (arg as import('ts-morph').StringLiteral).getLiteralText()
  if (!name || !ENV_NAME_RE.test(name) || name.length < 2) return
  const line = node.getStartLineNumber()
  out.push({
    file: relPath,
    line,
    col: node.getStart(),
    varName: name,
    symbol: lineToSymbol.get(line) ?? '',
    hasDefault: envParentHasDefault(node),
    wrappedIn: envWrappingCallName(node),
  })
}

export function visitEnvVarReads(
  sf: SourceFile,
  relPath: string,
  out: EnvVarReadFact[],
): void {
  const content = sf.getFullText()
  if (!content.includes('process.env')) return

  const lineToSymbol = buildLineToSymbol(sf)

  sf.forEachDescendant((node) => {
    const k = node.getKind()
    if (k === SyntaxKind.PropertyAccessExpression) {
      tryEmitEnvFromPropertyAccess(node, relPath, lineToSymbol, out)
    } else if (k === SyntaxKind.ElementAccessExpression) {
      tryEmitEnvFromElementAccess(node, relPath, lineToSymbol, out)
    }
  })
}
