// ADR-024 — Phase γ.4 prototype : AST → primitive Datalog tuples
/**
 * Visiteur AST UNIQUE qui émet des facts denormalisés sur lesquels les
 * détecteurs s'expriment ensuite comme rules Datalog (`.dl`).
 *
 * Architecture :
 *   1. Une seule passe AST par fichier (visitor design)
 *   2. Émet des tuples plats sérialisable cross-thread
 *   3. Les détecteurs (magic-numbers, dead-code, ...) deviennent des rules
 *      `.dl` qui filtrent / joignent ces primitives.
 *
 * Avantage vs Phase γ.2/γ.3 :
 *   - 1 traversée AST partagée pour TOUS les détecteurs (gain × N par-file)
 *   - Tuples = données pures (pas d'objets ts-morph) → IPC trivial
 *   - Cache disque possible (`.codegraph/ast-facts/<file>.tsv`)
 *   - Datalog engine optimise les rules (semi-naïve, indexes, parallel)
 *
 * Limites prototype :
 *   - Couvre pour l'instant les primitives nécessaires à magic-numbers +
 *     dead-code (identical-subexpressions). Les autres détecteurs ajoutent
 *     leurs primitives au visiteur incrémentalement.
 */

import { type SourceFile, Node, SyntaxKind } from 'ts-morph'

// ─── Tuple types ────────────────────────────────────────────────────────────

/**
 * Numeric literal avec contexte parent — primitive pour magic-numbers,
 * threshold-detection, etc.
 *
 * Schéma (.dl) :
 *   .decl NumericLiteralAst(
 *     file:symbol, line:number, valueText:symbol, valueAbs:number,
 *     parentKind:symbol, parentName:symbol, parentArgIdx:number,
 *     isScreamingSnake:number, isRatio:number)
 *
 * - parentKind ∈ {"CallExpression", "PropertyAssignment", "VariableDeclaration",
 *                 "BinaryExpression", "Other"}
 * - parentName : nom callee / propname / varname / op selon parentKind
 * - parentArgIdx : index dans la liste args si CallExpression, sinon -1
 * - isScreamingSnake : 1 si var SCREAMING_SNAKE_CASE
 * - isRatio : 1 si 0 < value < 1
 */
export interface NumericLiteralFact {
  file: string
  line: number
  valueText: string
  valueAbs: number
  parentKind: 'CallExpression' | 'PropertyAssignment' | 'VariableDeclaration' | 'BinaryExpression' | 'Other'
  parentName: string
  parentArgIdx: number
  isScreamingSnake: number
  isRatio: number
  /** 1 si la valeur numérique parsée ∈ {0, 1, -1, 2, 100, 1000}. */
  isTrivial: number
}

/**
 * Binary expression — primitive pour dead-code (identical sub-expressions),
 * eval-calls (specific operator patterns), etc.
 *
 * Schéma :
 *   .decl BinaryExpressionAst(
 *     file:symbol, line:number, op:symbol, leftText:symbol, rightText:symbol,
 *     leftIsShortLiteral:number)
 */
export interface BinaryExpressionFact {
  file: string
  line: number
  op: string
  leftText: string
  rightText: string
  leftIsShortLiteral: number
}

/**
 * Exemption marker — `// dead-code-ok: <reason>`. Émis sur la ligne du
 * construct exempté (pas la ligne du commentaire) — résolution main-thread.
 *
 * Schéma : .decl ExemptionLine(file:symbol, line:number, marker:symbol)
 */
export interface ExemptionLineFact {
  file: string
  line: number
  marker: string
}

/**
 * Tag fichier — `IsTestFile`, `IsFixtureFile`, etc.
 * Schéma : .decl FileTag(file:symbol, tag:symbol)
 */
export interface FileTagFact {
  file: string
  tag: string
}

export interface AstFactsBundle {
  numericLiterals: NumericLiteralFact[]
  binaryExpressions: BinaryExpressionFact[]
  exemptionLines: ExemptionLineFact[]
  fileTags: FileTagFact[]
}

// ─── Visitor ────────────────────────────────────────────────────────────────

const TEST_FILE_RE = /(\.test\.tsx?|\.spec\.tsx?|(^|\/)tests?\/|(^|\/)fixtures?\/)/
const SCREAMING_SNAKE_RE = /^[A-Z][A-Z0-9_]*$/
const SHORT_LITERAL_RE = /^[\d"'`]/
const SHORT_LITERAL_MAX_LEN = 4
const TRIVIAL_VALUES = new Set<number>([0, 1, -1, 2, 100, 1000])
// Subset des opérateurs binaires considérés comme comparison pour la rule
// MagicNumber large-int (ex `x > 5000`). Source = COMPARISON_OPS dans
// extractors/magic-numbers.ts.
const COMPARISON_OPS_FOR_MAGIC = new Set<string>([
  '>', '<', '>=', '<=', '===', '==', '!==', '!=',
])

const EXEMPTION_MARKERS = new Set([
  'dead-code-ok',
  'magic-numbers-ok',
  'complexity-ok',
  'secret-ok',
  'eval-ok',
  'crypto-ok',
])

/**
 * Visiteur unique : 1 passe AST → tous les tuples nécessaires aux détecteurs
 * supportés. Pure (read-only sur sf), idempotente, déterministe.
 */
export function extractAstFactsBundle(sf: SourceFile, relPath: string): AstFactsBundle {
  const numericLiterals: NumericLiteralFact[] = []
  const binaryExpressions: BinaryExpressionFact[] = []
  const exemptionLines: ExemptionLineFact[] = []
  const fileTags: FileTagFact[] = []

  if (TEST_FILE_RE.test(relPath)) {
    fileTags.push({ file: relPath, tag: 'test' })
  }

  visitNumericLiterals(sf, relPath, numericLiterals)
  visitBinaryExpressions(sf, relPath, binaryExpressions)
  visitExemptionMarkers(sf, relPath, exemptionLines)

  return { numericLiterals, binaryExpressions, exemptionLines, fileTags }
}

function visitNumericLiterals(
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

    let parentKind: NumericLiteralFact['parentKind'] = 'Other'
    let parentName = ''
    let parentArgIdx = -1
    let isScreamingSnake = 0

    if (Node.isCallExpression(parent)) {
      parentKind = 'CallExpression'
      parentName = getCalleeName(parent.getExpression()) ?? ''
      parentArgIdx = parent.getArguments().findIndex((a) => a === lit)
    } else if (Node.isPropertyAssignment(parent)) {
      parentKind = 'PropertyAssignment'
      parentName = parent.getName()
    } else if (Node.isVariableDeclaration(parent)) {
      parentKind = 'VariableDeclaration'
      parentName = parent.getName()
      isScreamingSnake = SCREAMING_SNAKE_RE.test(parentName) ? 1 : 0
    } else if (Node.isBinaryExpression(parent)) {
      const op = parent.getOperatorToken().getText()
      // Match legacy classifyBinaryComparison : seul comparison_ops capture,
      // contexte = "compare <op>" (intention humaine du detector).
      if (COMPARISON_OPS_FOR_MAGIC.has(op)) {
        parentKind = 'BinaryExpression'
        parentName = `compare ${op}`
      }
    }

    // valueAbs : Datalog number column = integer. On floor — les rules
    // comparent uniquement >= 1000 donc les floats < 1 (ratios) deviennent
    // 0, comparison déjà gérée séparément via isRatio.
    out.push({
      file: relPath,
      line: lit.getStartLineNumber(),
      valueText: text,
      valueAbs: Math.trunc(Math.abs(value)),
      parentKind,
      parentName,
      parentArgIdx,
      isScreamingSnake,
      isRatio: value > 0 && value < 1 ? 1 : 0,
      isTrivial: TRIVIAL_VALUES.has(value) ? 1 : 0,
    })
  }
}

function visitBinaryExpressions(
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

function visitExemptionMarkers(
  sf: SourceFile,
  relPath: string,
  out: ExemptionLineFact[],
): void {
  // Scan textuel : `// <marker>: <reason>` ou `// <marker>` puis trouve la
  // ligne du prochain non-blank/non-comment pour mapper l'exemption au
  // construct exempté. Reproduit la sémantique de makeIsExemptForMarker.
  const fullText = sf.getFullText()
  const lines = fullText.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    const m = /^\/\/\s*([a-z][\w-]+)(?:[:\s]|$)/.exec(trimmed)
    if (!m) continue
    const marker = m[1]
    if (!EXEMPTION_MARKERS.has(marker)) continue
    // Trouve la ligne du prochain construct (non-blank, non-commentaire).
    let target = -1
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim()
      if (t === '') continue
      if (t.startsWith('//')) continue
      target = j + 1  // 1-indexé
      break
    }
    if (target === -1) continue
    out.push({ file: relPath, line: target, marker })
  }
}

function getCalleeName(expr: Node): string | null {
  if (Node.isIdentifier(expr)) return expr.getText()
  if (Node.isPropertyAccessExpression(expr)) return expr.getName()
  return null
}
