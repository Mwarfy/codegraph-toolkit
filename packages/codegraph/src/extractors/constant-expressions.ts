// ADR-005
/**
 * Constant Expressions extractor — patterns de simplification symbolique
 * détectables statiquement via ts-morph + TypeScript Type Checker.
 *
 * Différenciation vs dead-code.ts :
 *   - dead-code.ts : `a === a` (identical sub-expressions, S1764)
 *   - this file    : `if (true)`, `x === false`, branches unreachable,
 *                    boolean coercion gratuite, literal folding
 *
 * Patterns détectés :
 *
 * 1. **tautology-condition** : `if (true)`, `while (true)` (sauf ts-loop pattern),
 *    `cond || true`, `cond && false`. Branche dead potentielle.
 *    (Sonar S2589 — "Boolean expressions should not be gratuitous")
 *
 * 2. **contradiction-condition** : `if (false)`, `cond && false`, etc.
 *    Branche unreachable.
 *
 * 3. **gratuitous-bool-comparison** : `x === true`, `x !== false`, etc.
 *    Le compare est superflu si x est déjà boolean. (Sonar S1125)
 *
 * 4. **double-negation** : `!!x` hors d'un cast vers boolean.
 *    Gratuit dans la plupart des contextes.
 *
 * 5. **literal-fold-opportunity** : `1 + 2`, `'a' + 'b'` — résolvables
 *    à compile-time. Suggestion d'inline. (Faible priorité, info-only.)
 *
 * Skip :
 *   - Test files (les fixtures peuvent contenir intentionnellement ces patterns)
 *   - `while (true)` qui suit le pattern infinite-event-loop / poll-loop
 *     (gated par exempt comment ou patterns connus avec break/return inside)
 *
 * Convention exempt : `// const-expr-ok: <reason>` sur ligne précédente.
 *
 * IMPORTANCE STRATÉGIQUE :
 *   Les findings standalone sont surclassés par ESLint/SonarQube. La
 *   vraie valeur est l'EMISSION DE FACTS qui se composent ensuite avec
 *   les autres facts du toolkit (TruthPointWriter, GrangerCausality,
 *   CycleNode, !TestedFile) via datalog rules. Voir `composite-*-in-*.dl`.
 */

import { type SourceFile, Node, SyntaxKind } from 'ts-morph'
import { makeIsExemptForMarker } from './_shared/ast-helpers.js'

export type ConstantExpressionKind =
  | 'tautology-condition'
  | 'contradiction-condition'
  | 'gratuitous-bool-comparison'
  | 'double-negation'
  | 'literal-fold-opportunity'

export interface ConstantExpressionFinding {
  kind: ConstantExpressionKind
  file: string
  line: number
  /** Court ≤ 120 chars, actionnable. */
  message: string
  /** Forme canonique de l'expression incriminée (≤ 80 chars, normalisée). */
  exprRepr: string
}

export interface ConstantExpressionsFileBundle {
  findings: ConstantExpressionFinding[]
}

const TEST_FILE_RE = /(\.test\.tsx?|\.spec\.tsx?|(^|\/)tests?\/|(^|\/)__tests__\/|(^|\/)fixtures?\/)/

type IsExempt = (line: number) => boolean

function emitConstantConditionFinding(
  cond: Node,
  line: number,
  relPath: string,
  ctx: 'if' | 'ternary',
  findings: ConstantExpressionFinding[],
): void {
  const verdict = classifyConstantBoolean(cond)
  if (verdict === 'always-true') {
    findings.push({
      kind: 'tautology-condition',
      file: relPath, line,
      message: ctx === 'if'
        ? 'if condition always true — else branch unreachable'
        : 'ternary condition always true — only "then" branch reachable',
      exprRepr: truncate(cond.getText()),
    })
  } else if (verdict === 'always-false') {
    findings.push({
      kind: 'contradiction-condition',
      file: relPath, line,
      message: ctx === 'if'
        ? 'if condition always false — then branch unreachable'
        : 'ternary condition always false — only "else" branch reachable',
      exprRepr: truncate(cond.getText()),
    })
  }
}

function detectTautologyContradictions(
  sf: SourceFile,
  relPath: string,
  isExempt: IsExempt,
  findings: ConstantExpressionFinding[],
): void {
  for (const ifNode of sf.getDescendantsOfKind(SyntaxKind.IfStatement)) {
    const line = ifNode.getStartLineNumber()
    if (isExempt(line)) continue
    emitConstantConditionFinding(ifNode.getExpression(), line, relPath, 'if', findings)
  }
  for (const tern of sf.getDescendantsOfKind(SyntaxKind.ConditionalExpression)) {
    const line = tern.getStartLineNumber()
    if (isExempt(line)) continue
    emitConstantConditionFinding(tern.getCondition(), line, relPath, 'ternary', findings)
  }
}

const EQ_NEQ_OPS = new Set([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
])

function detectGratuitousBoolComparisons(
  sf: SourceFile,
  relPath: string,
  isExempt: IsExempt,
  findings: ConstantExpressionFinding[],
): void {
  for (const bin of sf.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (!EQ_NEQ_OPS.has(bin.getOperatorToken().getKind())) continue
    const line = bin.getStartLineNumber()
    if (isExempt(line)) continue
    if (isBoolLiteral(bin.getLeft()) || isBoolLiteral(bin.getRight())) {
      findings.push({
        kind: 'gratuitous-bool-comparison',
        file: relPath, line,
        message: 'comparison with true/false literal — compare boolean directly',
        exprRepr: truncate(bin.getText()),
      })
    }
  }
}

/**
 * Heuristique : !! est utile si conversion explicite en boolean (return,
 * cast as boolean, init de const). Skip ces contextes — sinon gratuit.
 */
function isDoubleNegationContextOk(parent: Node | undefined): boolean {
  if (!parent) return false
  return Node.isReturnStatement(parent)
    || Node.isAsExpression(parent)
    || Node.isVariableDeclaration(parent)
}

function detectDoubleNegations(
  sf: SourceFile,
  relPath: string,
  isExempt: IsExempt,
  findings: ConstantExpressionFinding[],
): void {
  for (const prefix of sf.getDescendantsOfKind(SyntaxKind.PrefixUnaryExpression)) {
    if (prefix.getOperatorToken() !== SyntaxKind.ExclamationToken) continue
    const inner = prefix.getOperand()
    if (!Node.isPrefixUnaryExpression(inner)) continue
    if (inner.getOperatorToken() !== SyntaxKind.ExclamationToken) continue
    const line = prefix.getStartLineNumber()
    if (isExempt(line)) continue
    if (isDoubleNegationContextOk(prefix.getParent())) continue
    findings.push({
      kind: 'double-negation',
      file: relPath, line,
      message: '!! gratuitous in boolean context — use directly',
      exprRepr: truncate(prefix.getText()),
    })
  }
}

/**
 * Pattern literal-fold-opportunity : limite a `0 + X` / `X + 0` (no-op).
 * Pas de signal sur `60 * 60 * 1000` qu'humain garde lisible volontairement.
 */
function detectLiteralFoldOpportunities(
  sf: SourceFile,
  relPath: string,
  isExempt: IsExempt,
  findings: ConstantExpressionFinding[],
): void {
  for (const bin of sf.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (bin.getOperatorToken().getKind() !== SyntaxKind.PlusToken) continue
    const line = bin.getStartLineNumber()
    if (isExempt(line)) continue
    if (isZeroLiteral(bin.getLeft()) || isZeroLiteral(bin.getRight())) {
      findings.push({
        kind: 'literal-fold-opportunity', file: relPath, line,
        message: 'addition with 0 — no-op, can simplify',
        exprRepr: truncate(bin.getText()),
      })
    }
  }
}

export function extractConstantExpressionsFileBundle(
  sf: SourceFile,
  relPath: string,
): ConstantExpressionsFileBundle {
  if (TEST_FILE_RE.test(relPath)) return { findings: [] }
  const findings: ConstantExpressionFinding[] = []
  const isExempt = makeIsExemptForMarker(sf, 'const-expr-ok')

  detectTautologyContradictions(sf, relPath, isExempt, findings)
  detectGratuitousBoolComparisons(sf, relPath, isExempt, findings)
  detectDoubleNegations(sf, relPath, isExempt, findings)
  detectLiteralFoldOpportunities(sf, relPath, isExempt, findings)

  // Determinism : tri lex (file, line, kind)
  findings.sort((a, b) =>
    a.line !== b.line ? a.line - b.line :
    a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0,
  )

  return { findings }
}

// ─── Helpers ─────────────────────────────────────────────────────────

type BoolVerdict = 'always-true' | 'always-false' | 'unknown'

function classifyLiteralBoolean(node: Node): BoolVerdict {
  if (node.getKind() === SyntaxKind.TrueKeyword) return 'always-true'
  if (node.getKind() === SyntaxKind.FalseKeyword) return 'always-false'
  if (Node.isNumericLiteral(node)) {
    return parseFloat(node.getText()) === 0 ? 'always-false' : 'always-true'
  }
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralText().length === 0 ? 'always-false' : 'always-true'
  }
  return 'unknown'
}

function classifyAndOr(node: import('ts-morph').BinaryExpression): BoolVerdict {
  const op = node.getOperatorToken().getKind()
  if (op !== SyntaxKind.AmpersandAmpersandToken && op !== SyntaxKind.BarBarToken) {
    return 'unknown'
  }
  const l = classifyConstantBoolean(node.getLeft())
  const r = classifyConstantBoolean(node.getRight())
  if (op === SyntaxKind.AmpersandAmpersandToken) {
    if (l === 'always-false' || r === 'always-false') return 'always-false'
    if (l === 'always-true' && r === 'always-true') return 'always-true'
    return 'unknown'
  }
  // Bar Bar (||)
  if (l === 'always-true' || r === 'always-true') return 'always-true'
  if (l === 'always-false' && r === 'always-false') return 'always-false'
  return 'unknown'
}

function classifyNegation(node: import('ts-morph').PrefixUnaryExpression): BoolVerdict {
  if (node.getOperatorToken() !== SyntaxKind.ExclamationToken) return 'unknown'
  const inner = classifyConstantBoolean(node.getOperand())
  if (inner === 'always-true') return 'always-false'
  if (inner === 'always-false') return 'always-true'
  return 'unknown'
}

function classifyConstantBoolean(node: Node): BoolVerdict {
  const lit = classifyLiteralBoolean(node)
  if (lit !== 'unknown') return lit
  if (Node.isBinaryExpression(node)) return classifyAndOr(node)
  if (Node.isPrefixUnaryExpression(node)) return classifyNegation(node)
  return 'unknown'
}

function isBoolLiteral(node: Node): boolean {
  return node.getKind() === SyntaxKind.TrueKeyword || node.getKind() === SyntaxKind.FalseKeyword
}

function isZeroLiteral(node: Node): boolean {
  if (!Node.isNumericLiteral(node)) return false
  return parseFloat(node.getText()) === 0
}

function truncate(s: string, max = 80): string {
  const oneline = s.replace(/\s+/g, ' ').trim()
  return oneline.length <= max ? oneline : oneline.slice(0, max - 3) + '...'
}
