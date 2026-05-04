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

/**
 * Call expression / new expression — primitive pour eval-calls,
 * crypto-algo, taint-sinks, sanitizers, etc.
 *
 * Schéma :
 *   .decl CallExpressionAst(
 *     file:symbol, line:number,
 *     calleeKind:symbol,         // "Identifier" | "PropertyAccess" | "Other"
 *     calleeName:symbol,         // "eval", "createHash", "Function", etc.
 *     calleeObjectLast:symbol,   // dernière segment de obj si PropertyAccess (lowercase) sinon ""
 *     firstArgKind:symbol,       // "string" | "number" | "boolean" | "other"
 *     firstArgValue:symbol,      // valeur littérale lowercased si string, "" sinon
 *     isNew:number,              // 1 si NewExpression, 0 sinon
 *     containingSymbol:symbol)
 */
export interface CallExpressionFact {
  file: string
  line: number
  calleeKind: 'Identifier' | 'PropertyAccess' | 'Other'
  calleeName: string
  calleeObjectLast: string
  firstArgKind: 'string' | 'number' | 'boolean' | 'other'
  firstArgValue: string
  isNew: number
  containingSymbol: string
}

/**
 * Function-like scope (function decl, method, arrow assigné à variable).
 * Schéma : .decl FunctionScope(file:symbol, line:number, name:symbol,
 *   totalParams:number, nameMatchesSetterPredicate:number)
 */
export interface FunctionScopeFact {
  file: string
  line: number
  name: string
  totalParams: number
  nameMatchesSetterPredicate: number
}

/**
 * Param d'une function-like scope. Joint via (file, scopeLine).
 * Schéma : .decl FunctionParam(file:symbol, scopeLine:number, paramIndex:number,
 *   paramName:symbol, typeText:symbol)
 */
export interface FunctionParamFact {
  file: string
  scopeLine: number
  paramIndex: number
  paramName: string
  typeText: string
}

export interface AstFactsBundle {
  numericLiterals: NumericLiteralFact[]
  binaryExpressions: BinaryExpressionFact[]
  exemptionLines: ExemptionLineFact[]
  fileTags: FileTagFact[]
  callExpressions: CallExpressionFact[]
  functionScopes: FunctionScopeFact[]
  functionParams: FunctionParamFact[]
}

// ─── Visitor ────────────────────────────────────────────────────────────────

const TEST_FILE_RE = /(\.test\.tsx?|\.spec\.tsx?|(^|\/)tests?\/|(^|\/)fixtures?\/)/
const SCREAMING_SNAKE_RE = /^[A-Z][A-Z0-9_]*$/
const SHORT_LITERAL_RE = /^[\d"'`]/
const SHORT_LITERAL_MAX_LEN = 4
const TRIVIAL_VALUES = new Set<number>([0, 1, -1, 2, 100, 1000])
const SETTER_PREDICATE_RE = /^(set|is|has|can|should|enable|disable|toggle)/i
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
  const callExpressions: CallExpressionFact[] = []
  const functionScopes: FunctionScopeFact[] = []
  const functionParams: FunctionParamFact[] = []

  if (TEST_FILE_RE.test(relPath)) {
    fileTags.push({ file: relPath, tag: 'test' })
  }

  visitNumericLiterals(sf, relPath, numericLiterals)
  visitBinaryExpressions(sf, relPath, binaryExpressions)
  visitExemptionMarkers(sf, relPath, exemptionLines)
  visitCallAndNewExpressions(sf, relPath, callExpressions)
  visitFunctionScopesAndParams(sf, relPath, functionScopes, functionParams)

  return {
    numericLiterals, binaryExpressions, exemptionLines, fileTags,
    callExpressions, functionScopes, functionParams,
  }
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

// ─── Call expressions (eval, crypto, sanitizers, taint-sinks, ...) ──────────

function visitCallAndNewExpressions(
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
    // dernière segment lowercased — match `crypto`, `node:crypto`, etc.
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

/**
 * Best-effort enclosing function/method/arrow-var name. Reproduit
 * `findContainingSymbol` du extractors/_shared (qu'on évite d'importer
 * pour garder le visitor self-contained — duplication assumée).
 */
function findContainingSymbol(node: Node): string {
  let cur: Node | undefined = node.getParent()
  while (cur) {
    if (Node.isFunctionDeclaration(cur)) return cur.getName() ?? ''
    if (Node.isMethodDeclaration(cur)) return cur.getName()
    if (Node.isArrowFunction(cur) || Node.isFunctionExpression(cur)) {
      const p = cur.getParent()
      if (p && Node.isVariableDeclaration(p)) return p.getName()
      if (p && Node.isPropertyAssignment(p)) return p.getName()
    }
    cur = cur.getParent()
  }
  return ''
}

// ─── Function scopes + params (boolean-params) ──────────────────────────────

function visitFunctionScopesAndParams(
  sf: SourceFile,
  relPath: string,
  scopesOut: FunctionScopeFact[],
  paramsOut: FunctionParamFact[],
): void {
  for (const fn of sf.getFunctions()) {
    const name = fn.getName() ?? '(anonymous)'
    pushScopeAndParams(relPath, fn.getStartLineNumber(), name,
      fn.getParameters().map((p) => ({
        name: p.getName(),
        typeText: (p.getTypeNode()?.getText() ?? p.getType().getText()).trim(),
      })),
      scopesOut, paramsOut)
  }
  for (const cls of sf.getClasses()) {
    const className = cls.getName() ?? '(anonymous)'
    for (const m of cls.getMethods()) {
      const fullName = `${className}.${m.getName()}`
      pushScopeAndParams(relPath, m.getStartLineNumber(), fullName,
        m.getParameters().map((p) => ({
          name: p.getName(),
          typeText: (p.getTypeNode()?.getText() ?? p.getType().getText()).trim(),
        })),
        scopesOut, paramsOut)
    }
  }
  for (const v of sf.getVariableDeclarations()) {
    const init = v.getInitializer()
    if (!init) continue
    if (!Node.isArrowFunction(init) && !Node.isFunctionExpression(init)) continue
    pushScopeAndParams(relPath, v.getStartLineNumber(), v.getName(),
      init.getParameters().map((p) => ({
        name: p.getName(),
        typeText: (p.getTypeNode()?.getText() ?? p.getType().getText()).trim(),
      })),
      scopesOut, paramsOut)
  }
}

function pushScopeAndParams(
  file: string,
  line: number,
  name: string,
  params: Array<{ name: string; typeText: string }>,
  scopesOut: FunctionScopeFact[],
  paramsOut: FunctionParamFact[],
): void {
  scopesOut.push({
    file, line, name,
    totalParams: params.length,
    nameMatchesSetterPredicate: SETTER_PREDICATE_RE.test(name) ? 1 : 0,
  })
  for (let i = 0; i < params.length; i++) {
    const p = params[i]
    paramsOut.push({
      file, scopeLine: line, paramIndex: i,
      paramName: p.name, typeText: p.typeText,
    })
  }
}
