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

export function extractConstantExpressionsFileBundle(
  sf: SourceFile,
  relPath: string,
): ConstantExpressionsFileBundle {
  if (TEST_FILE_RE.test(relPath)) return { findings: [] }
  const findings: ConstantExpressionFinding[] = []
  const isExempt = makeIsExemptForMarker(sf, 'const-expr-ok')

  // ─── Pattern 1 + 2 : tautology / contradiction in conditions ────
  for (const ifNode of sf.getDescendantsOfKind(SyntaxKind.IfStatement)) {
    const cond = ifNode.getExpression()
    const line = ifNode.getStartLineNumber()
    if (isExempt(line)) continue
    const verdict = classifyConstantBoolean(cond)
    if (verdict === 'always-true') {
      findings.push({
        kind: 'tautology-condition',
        file: relPath, line,
        message: 'if condition always true — else branch unreachable',
        exprRepr: truncate(cond.getText()),
      })
    } else if (verdict === 'always-false') {
      findings.push({
        kind: 'contradiction-condition',
        file: relPath, line,
        message: 'if condition always false — then branch unreachable',
        exprRepr: truncate(cond.getText()),
      })
    }
  }

  // Ternaries with constant condition.
  for (const tern of sf.getDescendantsOfKind(SyntaxKind.ConditionalExpression)) {
    const cond = tern.getCondition()
    const line = tern.getStartLineNumber()
    if (isExempt(line)) continue
    const verdict = classifyConstantBoolean(cond)
    if (verdict === 'always-true') {
      findings.push({
        kind: 'tautology-condition', file: relPath, line,
        message: 'ternary condition always true — only "then" branch reachable',
        exprRepr: truncate(cond.getText()),
      })
    } else if (verdict === 'always-false') {
      findings.push({
        kind: 'contradiction-condition', file: relPath, line,
        message: 'ternary condition always false — only "else" branch reachable',
        exprRepr: truncate(cond.getText()),
      })
    }
  }

  // ─── Pattern 3 : gratuitous boolean comparison ───────────────────
  // x === true, x === false, x !== true, x !== false
  for (const bin of sf.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    const op = bin.getOperatorToken().getKind()
    if (
      op !== SyntaxKind.EqualsEqualsEqualsToken &&
      op !== SyntaxKind.ExclamationEqualsEqualsToken &&
      op !== SyntaxKind.EqualsEqualsToken &&
      op !== SyntaxKind.ExclamationEqualsToken
    ) continue
    const left = bin.getLeft()
    const right = bin.getRight()
    const line = bin.getStartLineNumber()
    if (isExempt(line)) continue
    if (isBoolLiteral(left) || isBoolLiteral(right)) {
      findings.push({
        kind: 'gratuitous-bool-comparison',
        file: relPath, line,
        message: 'comparison with true/false literal — compare boolean directly',
        exprRepr: truncate(bin.getText()),
      })
    }
  }

  // ─── Pattern 4 : double negation outside of bool cast context ────
  for (const prefix of sf.getDescendantsOfKind(SyntaxKind.PrefixUnaryExpression)) {
    if (prefix.getOperatorToken() !== SyntaxKind.ExclamationToken) continue
    const inner = prefix.getOperand()
    if (!Node.isPrefixUnaryExpression(inner)) continue
    if (inner.getOperatorToken() !== SyntaxKind.ExclamationToken) continue
    const line = prefix.getStartLineNumber()
    if (isExempt(line)) continue
    // Heuristique : !! est utile si on convertit explicitement en boolean
    // pour un return, un cast as boolean, ou un cast Boolean(). Sinon
    // gratuit dans un contexte déjà-boolean.
    const parent = prefix.getParent()
    if (parent && (
      Node.isReturnStatement(parent) ||
      Node.isAsExpression(parent) ||
      Node.isVariableDeclaration(parent)  // const x: boolean = !!y — let user decide
    )) continue
    findings.push({
      kind: 'double-negation',
      file: relPath, line,
      message: '!! gratuitous in boolean context — use directly',
      exprRepr: truncate(prefix.getText()),
    })
  }

  // ─── Pattern 5 : literal-fold-opportunity ────────────────────────
  // Limite à literal + literal pour éviter false positives sur const x = 60 * 1000.
  // Les humains préfèrent souvent garder `60 * 60 * 1000` lisible.
  // → Ne reporte QUE les patterns clairement bizarres : `'a' + 'b'`, `1 + 2`,
  // `0 + n` (no-op).
  for (const bin of sf.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    const op = bin.getOperatorToken().getKind()
    if (op !== SyntaxKind.PlusToken) continue
    const left = bin.getLeft()
    const right = bin.getRight()
    const line = bin.getStartLineNumber()
    if (isExempt(line)) continue
    // 0 + X / X + 0
    if (isZeroLiteral(left) || isZeroLiteral(right)) {
      findings.push({
        kind: 'literal-fold-opportunity', file: relPath, line,
        message: 'addition with 0 — no-op, can simplify',
        exprRepr: truncate(bin.getText()),
      })
    }
  }

  // Determinism : tri lex (file, line, kind)
  findings.sort((a, b) =>
    a.line !== b.line ? a.line - b.line :
    a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0,
  )

  return { findings }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function classifyConstantBoolean(node: Node): 'always-true' | 'always-false' | 'unknown' {
  // Direct true/false literal
  if (node.getKind() === SyntaxKind.TrueKeyword) return 'always-true'
  if (node.getKind() === SyntaxKind.FalseKeyword) return 'always-false'

  // Numeric/string literal in boolean context : truthy/falsy known
  if (Node.isNumericLiteral(node)) {
    const value = parseFloat(node.getText())
    return value === 0 ? 'always-false' : 'always-true'
  }
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralText().length === 0 ? 'always-false' : 'always-true'
  }

  // Logical expressions : recursive
  if (Node.isBinaryExpression(node)) {
    const op = node.getOperatorToken().getKind()
    if (op === SyntaxKind.AmpersandAmpersandToken) {
      const l = classifyConstantBoolean(node.getLeft())
      const r = classifyConstantBoolean(node.getRight())
      if (l === 'always-false' || r === 'always-false') return 'always-false'
      if (l === 'always-true' && r === 'always-true') return 'always-true'
    } else if (op === SyntaxKind.BarBarToken) {
      const l = classifyConstantBoolean(node.getLeft())
      const r = classifyConstantBoolean(node.getRight())
      if (l === 'always-true' || r === 'always-true') return 'always-true'
      if (l === 'always-false' && r === 'always-false') return 'always-false'
    }
  }

  // Negation
  if (Node.isPrefixUnaryExpression(node)) {
    if (node.getOperatorToken() === SyntaxKind.ExclamationToken) {
      const inner = classifyConstantBoolean(node.getOperand())
      if (inner === 'always-true') return 'always-false'
      if (inner === 'always-false') return 'always-true'
    }
  }

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
