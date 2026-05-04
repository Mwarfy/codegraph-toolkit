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
import { findContainingSymbol as sharedFindContainingSymbol } from '../extractors/_shared/ast-helpers.js'

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

/**
 * Sanitizer candidate (visitor pre-computes match avec lookup + regex
 * — l'engine Datalog ne supporte pas les regex/string ops).
 *
 * Schéma : .decl SanitizerCandidate(file:symbol, line:number,
 *   callee:symbol, containingSymbol:symbol)
 */
export interface SanitizerCandidateFact {
  file: string
  line: number
  callee: string
  containingSymbol: string
}

/**
 * Taint sink candidate (visitor pre-computes la classification
 * methodName→kind + objectName ∈ HIGH_CONFIDENCE_OBJECTS regex).
 *
 * Schéma : .decl TaintSinkCandidate(file:symbol, line:number, kind:symbol,
 *   callee:symbol, containingSymbol:symbol)
 */
export interface TaintSinkCandidateFact {
  file: string
  line: number
  kind: string
  callee: string
  containingSymbol: string
}

/**
 * Long function candidate (visitor pré-compte les LOC du body).
 *
 * Schéma : .decl LongFunctionCandidate(file:symbol, line:number,
 *   name:symbol, loc:number, kind:symbol)
 */
export interface LongFunctionCandidateFact {
  file: string
  line: number
  name: string
  loc: number
  kind: 'function' | 'method' | 'arrow'
}

/**
 * Function complexity (cyclomatic + cognitive pré-computés en visitor —
 * trop complexe à exprimer en Datalog pur).
 *
 * Schéma : .decl FunctionComplexityFact(file:symbol, line:number,
 *   name:symbol, cyclomatic:number, cognitive:number, containingClass:symbol)
 */
export interface FunctionComplexityFact {
  file: string
  line: number
  name: string
  cyclomatic: number
  cognitive: number
  containingClass: string
}

/**
 * Hardcoded secret candidate (visitor calcule entropy de Shannon, filtre
 * par taille + context). Emit que les candidats qui passent les checks.
 *
 * Schéma : .decl HardcodedSecretCandidate(file:symbol, line:number,
 *   varOrPropName:symbol, sample:symbol, entropyX1000:number, length:number)
 */
export interface HardcodedSecretCandidateFact {
  file: string
  line: number
  varOrPropName: string
  sample: string
  entropyX1000: number
  length: number
}

export interface AstFactsBundle {
  numericLiterals: NumericLiteralFact[]
  binaryExpressions: BinaryExpressionFact[]
  exemptionLines: ExemptionLineFact[]
  fileTags: FileTagFact[]
  callExpressions: CallExpressionFact[]
  functionScopes: FunctionScopeFact[]
  functionParams: FunctionParamFact[]
  sanitizerCandidates: SanitizerCandidateFact[]
  taintSinkCandidates: TaintSinkCandidateFact[]
  longFunctionCandidates: LongFunctionCandidateFact[]
  functionComplexities: FunctionComplexityFact[]
  hardcodedSecretCandidates: HardcodedSecretCandidateFact[]
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
  const sanitizerCandidates: SanitizerCandidateFact[] = []
  const taintSinkCandidates: TaintSinkCandidateFact[] = []
  const longFunctionCandidates: LongFunctionCandidateFact[] = []
  const functionComplexities: FunctionComplexityFact[] = []
  const hardcodedSecretCandidates: HardcodedSecretCandidateFact[] = []

  const isTest = TEST_FILE_RE.test(relPath)
  if (isTest) fileTags.push({ file: relPath, tag: 'test' })

  visitNumericLiterals(sf, relPath, numericLiterals)
  visitBinaryExpressions(sf, relPath, binaryExpressions)
  visitExemptionMarkers(sf, relPath, exemptionLines)
  visitCallAndNewExpressions(sf, relPath, callExpressions)
  visitFunctionScopesAndParams(sf, relPath, functionScopes, functionParams)

  // Détecteurs hybrides : visitor pré-compute la classification, rules
  // Datalog filtrent test+exempt seulement. Skip total si test file pour
  // éviter de générer des candidats qui seraient ensuite filtrés
  // (perf — les sets candidats peuvent être gros sur les tests/fixtures).
  if (!isTest) {
    visitSanitizerCandidates(sf, relPath, sanitizerCandidates)
    visitTaintSinkCandidates(sf, relPath, taintSinkCandidates)
    visitLongFunctionAndComplexityCandidates(
      sf, relPath, longFunctionCandidates, functionComplexities,
    )
    visitHardcodedSecretCandidates(sf, relPath, hardcodedSecretCandidates)
  }

  return {
    numericLiterals, binaryExpressions, exemptionLines, fileTags,
    callExpressions, functionScopes, functionParams,
    sanitizerCandidates, taintSinkCandidates,
    longFunctionCandidates, functionComplexities,
    hardcodedSecretCandidates,
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

// findContainingSymbol = re-export du helper partagé (alias local). Garantit
// la même résolution scope-name (Class.method, var name, etc.) que les
// extractors legacy → BIT-IDENTICAL containingSymbol cross-runs.
const findContainingSymbol = sharedFindContainingSymbol

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

// ─── Sanitizers (Phase 4 Tier 10) ───────────────────────────────────────────

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

function visitSanitizerCandidates(
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

// ─── Taint sinks (Phase 4 Tier 10) ──────────────────────────────────────────

const SINK_METHOD_TO_KIND = new Map<string, string>()
;(() => {
  const patterns: Array<[string, string[]]> = [
    ['sql',      ['query', 'raw', 'execute']],
    ['eval',     ['eval']],
    ['exec',     ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']],
    ['fs-read',  ['readFile', 'readFileSync', 'createReadStream', 'readdir', 'readdirSync']],
    ['fs-write', ['writeFile', 'writeFileSync', 'createWriteStream', 'appendFile', 'unlink', 'rm', 'rmSync']],
    ['http-out', ['fetch', 'request', 'get', 'post', 'put', 'delete', 'patch']],
    ['html-out', ['send', 'render', 'innerHTML', 'outerHTML']],
    ['log',      ['info', 'warn', 'error', 'debug', 'log', 'trace', 'fatal']],
    ['redirect', ['redirect', 'setHeader', 'writeHead']],
  ]
  for (const [kind, methods] of patterns) {
    for (const m of methods) SINK_METHOD_TO_KIND.set(m, kind)
  }
})()

const SINK_HIGH_CONFIDENCE: Record<string, RegExp> = {
  'sql':      /^(db|pool|client|knex|prisma|sql|connection|conn|database)$/i,
  'eval':     /.*/,
  'exec':     /^(child_process|cp|childProcess)$/i,
  'fs-read':  /^(fs|fsPromises|fsp)$/i,
  'fs-write': /^(fs|fsPromises|fsp)$/i,
  'http-out': /^(axios|http|https|got|fetch|node_fetch|nodeFetch)$/i,
  'html-out': /^(res|response|element|document)$/i,
  'log':      /^(logger|log|console|pino|winston|bunyan)$/i,
  'redirect': /^(res|response|ctx|reply)$/i,
}

function visitTaintSinkCandidates(
  sf: SourceFile,
  relPath: string,
  out: TaintSinkCandidateFact[],
): void {
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression()
    let methodName: string | null = null
    let objectName: string | null = null
    let calleeText = ''
    if (Node.isIdentifier(callee)) {
      methodName = callee.getText()
      calleeText = methodName
    } else if (Node.isPropertyAccessExpression(callee)) {
      methodName = callee.getName()
      calleeText = callee.getText()
      const exprNode = callee.getExpression()
      if (Node.isIdentifier(exprNode)) objectName = exprNode.getText()
      else if (Node.isPropertyAccessExpression(exprNode)) objectName = exprNode.getName()
    } else continue
    if (!methodName) continue
    const kind = SINK_METHOD_TO_KIND.get(methodName)
    if (!kind) continue
    // High-confidence : objectName matches regex per kind, OR (no object AND
    // method is uniquely identifiable like eval/fetch).
    const hc = objectName
      ? SINK_HIGH_CONFIDENCE[kind].test(objectName)
      : (methodName === 'eval' || methodName === 'fetch')
    if (!hc) continue
    out.push({
      file: relPath,
      line: call.getStartLineNumber(),
      kind,
      callee: calleeText,
      containingSymbol: findContainingSymbol(call),
    })
  }
}

// ─── Long functions + Function complexity ───────────────────────────────────

const CYCLO_KINDS = new Set<number>([
  SyntaxKind.IfStatement,
  SyntaxKind.ConditionalExpression,
  SyntaxKind.CaseClause,
  SyntaxKind.ForStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.CatchClause,
])

const COG_NEST_KINDS = new Set<number>([
  SyntaxKind.IfStatement,
  SyntaxKind.ForStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.CatchClause,
  SyntaxKind.ConditionalExpression,
])

interface FnLikeWithBody {
  /** Just method/function/var name (no class prefix). */
  shortName: string
  body: Node
  line: number
  containingClass: string
  kind: 'function' | 'method' | 'arrow'
}

function* iterateFnLikesWithBody(sf: SourceFile): Generator<FnLikeWithBody> {
  for (const fn of sf.getFunctions()) {
    const body = fn.getBody()
    if (!body) continue
    yield {
      shortName: fn.getName() ?? '(anonymous)',
      body,
      line: fn.getStartLineNumber(),
      containingClass: '',
      kind: 'function',
    }
  }
  for (const cls of sf.getClasses()) {
    const className = cls.getName() ?? '(anonymous)'
    for (const m of cls.getMethods()) {
      const body = m.getBody()
      if (!body) continue
      yield {
        shortName: m.getName(),
        body,
        line: m.getStartLineNumber(),
        containingClass: className,
        kind: 'method',
      }
    }
  }
  for (const v of sf.getVariableDeclarations()) {
    const init = v.getInitializer()
    if (!init) continue
    if (!Node.isArrowFunction(init) && !Node.isFunctionExpression(init)) continue
    const body = init.getBody()
    if (!body) continue
    yield {
      shortName: v.getName(),
      body,
      line: v.getStartLineNumber(),
      containingClass: '',
      kind: 'arrow',
    }
  }
}

function visitLongFunctionAndComplexityCandidates(
  sf: SourceFile,
  relPath: string,
  longOut: LongFunctionCandidateFact[],
  cmplxOut: FunctionComplexityFact[],
): void {
  for (const fn of iterateFnLikesWithBody(sf)) {
    // Long-functions legacy : name = "Class.method" pour les methods, sinon shortName
    const longName = fn.kind === 'method' && fn.containingClass
      ? `${fn.containingClass}.${fn.shortName}`
      : fn.shortName
    longOut.push({
      file: relPath,
      line: fn.line,
      name: longName,
      loc: countLoc(fn.body.getText()),
      kind: fn.kind,
    })
    // Function-complexity legacy : name = juste shortName, containingClass séparé
    cmplxOut.push({
      file: relPath,
      line: fn.line,
      name: fn.shortName,
      cyclomatic: computeCyclomatic(fn.body),
      cognitive: computeCognitive(fn.body),
      containingClass: fn.containingClass,
    })
  }
}

function countLoc(bodyText: string): number {
  const lines = bodyText.split('\n')
  let count = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (trimmed === '{' || trimmed === '}') continue
    if (trimmed.startsWith('//')) continue
    if (trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.endsWith('*/')) continue
    count++
  }
  return count
}

function computeCyclomatic(node: Node): number {
  let count = 1
  node.forEachDescendant((child) => {
    const kind = child.getKind()
    if (CYCLO_KINDS.has(kind)) count++
    else if (kind === SyntaxKind.BinaryExpression) {
      const op = (child as unknown as { getOperatorToken: () => { getKind: () => number } })
        .getOperatorToken().getKind()
      if (op === SyntaxKind.AmpersandAmpersandToken
       || op === SyntaxKind.BarBarToken
       || op === SyntaxKind.QuestionQuestionToken) {
        count++
      }
    }
  })
  return count
}

function computeCognitive(node: Node): number {
  let total = 0
  const walk = (n: Node, nesting: number): void => {
    n.forEachChild((child) => {
      const kind = child.getKind()
      if (COG_NEST_KINDS.has(kind)) {
        total += 1 + nesting
        walk(child, nesting + 1)
      } else if (kind === SyntaxKind.SwitchStatement) {
        total += 1 + nesting
        walk(child, nesting + 1)
      } else if (kind === SyntaxKind.BinaryExpression) {
        const op = (child as unknown as { getOperatorToken: () => { getKind: () => number } })
          .getOperatorToken().getKind()
        if (op === SyntaxKind.AmpersandAmpersandToken
         || op === SyntaxKind.BarBarToken) {
          total += 1
        }
        walk(child, nesting)
      } else {
        walk(child, nesting)
      }
    })
  }
  walk(node, 0)
  return total
}

// ─── Hardcoded secrets (entropy + context) ──────────────────────────────────
// Match exact legacy extractors/hardcoded-secrets.ts : SUSPICIOUS_NAME_RE +
// KNOWN_PREFIX_RE, length >= 20, entropy >= 4.0 (×1000 = 4000) seulement
// pour le trigger "name". Iterate seulement StringLiteral (pas template).

const SECRET_SUSPICIOUS_NAME_RE =
  /\b(?:api[_-]?key|secret|token|password|passwd|pwd|credential|auth|bearer|access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret)\b/i

const SECRET_KNOWN_PREFIX_RE =
  /^(?:sk-[A-Za-z0-9]{20,}|sk_(?:test|live)_[A-Za-z0-9]{20,}|pk_(?:test|live)_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|xox[bps]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|ya29\.[0-9A-Za-z_-]{20,})/

const SECRET_MIN_LENGTH = 20
const SECRET_MIN_ENTROPY_X1000 = 4_000  // bits/char × 1000

function shannonEntropyX1000(s: string): number {
  if (s.length === 0) return 0
  const freq = new Map<string, number>()
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1)
  let h = 0
  for (const c of freq.values()) {
    const p = c / s.length
    h -= p * Math.log2(p)
  }
  return Math.trunc(h * 1000)
}

/**
 * Reproduit exactement findContext() du legacy : VariableDeclaration,
 * PropertyAssignment (avec strip quotes), BinaryExpression LHS PropertyAccess.
 */
function findSecretContext(node: Node): string | null {
  const parent = node.getParent()
  if (!parent) return null
  if (Node.isVariableDeclaration(parent)) return parent.getName()
  if (Node.isPropertyAssignment(parent)) {
    return parent.getName().replace(/^['"]|['"]$/g, '')
  }
  if (Node.isBinaryExpression(parent)) {
    const lhs = parent.getLeft()
    if (Node.isPropertyAccessExpression(lhs)) return lhs.getName()
  }
  return null
}

function visitHardcodedSecretCandidates(
  sf: SourceFile,
  relPath: string,
  out: HardcodedSecretCandidateFact[],
): void {
  for (const lit of sf.getDescendantsOfKind(SyntaxKind.StringLiteral)) {
    const value = lit.getLiteralText()
    if (value.length < SECRET_MIN_LENGTH) continue

    const context = findSecretContext(lit)
    let trigger: 'name' | 'pattern' | null = null
    if (SECRET_KNOWN_PREFIX_RE.test(value)) {
      trigger = 'pattern'
    } else if (context && SECRET_SUSPICIOUS_NAME_RE.test(context)) {
      trigger = 'name'
    }
    if (!trigger) continue

    const entX1000 = shannonEntropyX1000(value)
    // Pour 'name' trigger : exiger entropy >= 4. Pour 'pattern' : skip filter
    // (les prefixes connus sont déjà spécifiques).
    if (trigger === 'name' && entX1000 < SECRET_MIN_ENTROPY_X1000) continue

    out.push({
      file: relPath,
      line: lit.getStartLineNumber(),
      varOrPropName: context ?? '',
      sample: value.slice(0, Math.min(8, value.length)) + '…',
      entropyX1000: entX1000,
      length: value.length,
    })
  }
}
