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
import {
  findContainingSymbol as sharedFindContainingSymbol,
  buildLineToSymbol,
} from '../extractors/_shared/ast-helpers.js'

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
 * Barrel file fact — émis seulement si TOUS les top-level statements
 * sont des re-exports (pas de declarations). Schéma :
 *   .decl BarrelFileFact(file:symbol, reExportCount:number)
 */
export interface BarrelFileFact {
  file: string
  reExportCount: number
}

/**
 * Resolved import edge — pour count consumers per barrel + autres analyses
 * cross-file. Schéma :
 *   .decl ImportEdgeFact(fromFile:symbol, toFile:symbol)
 */
export interface ImportEdgeFact {
  fromFile: string
  toFile: string
}

/**
 * Env var read fact — `process.env.X` ou `process.env['X']`. Aggrégé
 * par-name côté runner. Schéma :
 *   .decl EnvVarRead(file:symbol, line:number, varName:symbol, sym:symbol,
 *     hasDefault:number, wrappedIn:symbol)
 */
export interface EnvVarReadFact {
  file: string
  line: number
  /** Column number (start offset) — disambigue plusieurs `process.env.X`
   *  sur la même ligne. Datalog dedupe les tuples identiques. */
  col: number
  varName: string
  symbol: string
  hasDefault: number
  /** Nom du callee si l'env access est arg d'un call (parseInt, Number, ...). */
  wrappedIn: string
}

/**
 * Event listener site candidate — `bus.on('e', h)`, `subscribe('e', h)`, etc.
 *
 * Schéma : .decl EventListenerSiteCandidate(file:symbol, line:number,
 *   symbol:symbol, callee:symbol, isMethodCall:number, receiver:symbol,
 *   kind:symbol, literalValue:symbol, refExpression:symbol)
 *
 * - kind ∈ "literal" | "eventConstRef" | "dynamic"
 * - literalValue : valeur si kind="literal", sinon ""
 * - refExpression : texte si kind="eventConstRef", sinon ""
 */
export interface EventListenerSiteCandidateFact {
  file: string
  line: number
  symbol: string
  callee: string
  isMethodCall: number
  receiver: string
  kind: string
  literalValue: string
  refExpression: string
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

/**
 * Drift pattern candidates (Tier "drift agentique"). 4 AST patterns
 * portés (todo-no-owner reste cross-file, hors visitor). Filtrage test
 * files spécifique drift (no fixtures, anchored $ — différent du visitor
 * TEST_FILE_RE).
 *
 * - ExcessiveOptionalParamsCandidate(file, line, name, kind, count)
 * - WrapperSuperfluousCandidate(file, line, name, kind, callee)
 * - DeepNestingCandidate(file, line, name, depth)
 * - EmptyCatchNoCommentCandidate(file, line)
 */
export interface ExcessiveOptionalParamsCandidateFact {
  file: string
  line: number
  name: string
  fnKind: string
  optionalCount: number
}

export interface WrapperSuperfluousCandidateFact {
  file: string
  line: number
  name: string
  fnKind: string
  callee: string
}

export interface DeepNestingCandidateFact {
  file: string
  line: number
  name: string
  maxDepth: number
}

export interface EmptyCatchNoCommentCandidateFact {
  file: string
  line: number
}

/**
 * Security pattern candidates (Tier 16). 4 facts émis :
 *   - SecretVarRefCandidate : var nommée secret/token/... passée en arg
 *   - CorsConfigCandidate   : cors({ origin: ... })
 *   - TlsUnsafeCandidate    : { rejectUnauthorized: false } etc.
 *   - WeakRandomCandidate   : Math.random() assigné à une var (kind si secret)
 */
export interface SecretVarRefCandidateFact {
  file: string
  line: number
  varName: string
  kind: string
  callee: string
  containingSymbol: string
}

export interface CorsConfigCandidateFact {
  file: string
  line: number
  originKind: string
  containingSymbol: string
}

export interface TlsUnsafeCandidateFact {
  file: string
  line: number
  key: string
  containingSymbol: string
}

export interface WeakRandomCandidateFact {
  file: string
  line: number
  varName: string
  secretKind: string
  containingSymbol: string
}

/**
 * Resource imbalance candidate (Tier 6). Visitor pré-compte les calls
 * acquire/release par scope et émet un fact si counts différents.
 *
 * Schéma : .decl ResourceImbalanceCandidate(file:symbol, sym:symbol,
 *   line:number, pair:symbol, acqCount:number, relCount:number)
 */
export interface ResourceImbalanceCandidateFact {
  file: string
  containingSymbol: string
  line: number
  pair: string
  acquireCount: number
  releaseCount: number
}

/**
 * Tainted var decl candidate (Tier 11). Visitor pré-classifie via
 * matchSource regex + destructuring patterns. Rule pass-through.
 *
 * Schéma : .decl TaintedVarDeclCandidate(file:symbol, sym:symbol,
 *   varName:symbol, line:number, source:symbol)
 */
export interface TaintedVarDeclCandidateFact {
  file: string
  containingSymbol: string
  varName: string
  line: number
  source: string
}

/**
 * Tainted arg call candidate (Tier 11). Visitor pré-classifie via
 * per-scope tainted-vars Map. Rule pass-through.
 *
 * Schéma : .decl TaintedVarArgCallCandidate(file:symbol, line:number,
 *   callee:symbol, argVarName:symbol, argIdx:number, source:symbol,
 *   sym:symbol)
 */
export interface TaintedVarArgCallCandidateFact {
  file: string
  line: number
  callee: string
  argVarName: string
  argIndex: number
  source: string
  containingSymbol: string
}

/**
 * Event emit site candidate (parallèle à event-listener-sites mais pour
 * emit({ type: ... })). Visitor pré-classifie literal / eventConstRef /
 * dynamic. Symbol résolu via buildLineToSymbol (legacy comportement).
 *
 * Schéma : .decl EventEmitSiteCandidate(file:symbol, line:number,
 *   sym:symbol, callee:symbol, isMethodCall:number, receiver:symbol,
 *   kind:symbol, literalValue:symbol, refExpression:symbol)
 */
export interface EventEmitSiteCandidateFact {
  file: string
  line: number
  symbol: string
  callee: string
  isMethodCall: number
  receiver: string
  kind: string
  literalValue: string
  refExpression: string
}

/**
 * Tainted argument candidate (cross-function taint analysis Tier 14).
 * Visitor pré-classifie via matchSource regex + per-scope tainted-vars Map.
 * Rule pass-through (test files filtré au visit-level).
 *
 * Schéma : .decl TaintedArgumentCandidate(callerFile:symbol, callerSymbol:symbol,
 *   callee:symbol, paramIndex:number, source:symbol)
 */
export interface TaintedArgumentCandidateFact {
  callerFile: string
  callerSymbol: string
  callee: string
  paramIndex: number
  source: string
}

/**
 * Constant expression candidate (visitor pré-classifie via classification
 * récursive bool / context check / literal-fold / etc.). Le rule filtre
 * uniquement test files + exempt markers.
 *
 * Schéma : .decl ConstantExpressionCandidate(file:symbol, line:number,
 *   kind:symbol, message:symbol, exprRepr:symbol)
 *
 * - kind ∈ "tautology-condition" | "contradiction-condition"
 *        | "gratuitous-bool-comparison" | "double-negation"
 *        | "literal-fold-opportunity"
 */
export interface ConstantExpressionCandidateFact {
  file: string
  line: number
  kind: string
  message: string
  exprRepr: string
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
  eventListenerSiteCandidates: EventListenerSiteCandidateFact[]
  barrelFiles: BarrelFileFact[]
  importEdges: ImportEdgeFact[]
  envVarReads: EnvVarReadFact[]
  constantExpressionCandidates: ConstantExpressionCandidateFact[]
  taintedArgumentCandidates: TaintedArgumentCandidateFact[]
  eventEmitSiteCandidates: EventEmitSiteCandidateFact[]
  taintedVarDeclCandidates: TaintedVarDeclCandidateFact[]
  taintedVarArgCallCandidates: TaintedVarArgCallCandidateFact[]
  resourceImbalanceCandidates: ResourceImbalanceCandidateFact[]
  secretVarRefCandidates: SecretVarRefCandidateFact[]
  corsConfigCandidates: CorsConfigCandidateFact[]
  tlsUnsafeCandidates: TlsUnsafeCandidateFact[]
  weakRandomCandidates: WeakRandomCandidateFact[]
  excessiveOptionalParamsCandidates: ExcessiveOptionalParamsCandidateFact[]
  wrapperSuperfluousCandidates: WrapperSuperfluousCandidateFact[]
  deepNestingCandidates: DeepNestingCandidateFact[]
  emptyCatchNoCommentCandidates: EmptyCatchNoCommentCandidateFact[]
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
  'const-expr-ok',
  'resource-balance-ok',
  'security-ok',
  'drift-ok',
])

/**
 * Visiteur unique : 1 passe AST → tous les tuples nécessaires aux détecteurs
 * supportés. Pure (read-only sur sf), idempotente, déterministe.
 */
export function extractAstFactsBundle(
  sf: SourceFile,
  relPath: string,
  rootDir: string = '',
): AstFactsBundle {
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
  const eventListenerSiteCandidates: EventListenerSiteCandidateFact[] = []
  const barrelFiles: BarrelFileFact[] = []
  const importEdges: ImportEdgeFact[] = []
  const envVarReads: EnvVarReadFact[] = []
  const constantExpressionCandidates: ConstantExpressionCandidateFact[] = []
  const taintedArgumentCandidates: TaintedArgumentCandidateFact[] = []
  const eventEmitSiteCandidates: EventEmitSiteCandidateFact[] = []
  const taintedVarDeclCandidates: TaintedVarDeclCandidateFact[] = []
  const taintedVarArgCallCandidates: TaintedVarArgCallCandidateFact[] = []
  const resourceImbalanceCandidates: ResourceImbalanceCandidateFact[] = []
  const secretVarRefCandidates: SecretVarRefCandidateFact[] = []
  const corsConfigCandidates: CorsConfigCandidateFact[] = []
  const tlsUnsafeCandidates: TlsUnsafeCandidateFact[] = []
  const weakRandomCandidates: WeakRandomCandidateFact[] = []
  const excessiveOptionalParamsCandidates: ExcessiveOptionalParamsCandidateFact[] = []
  const wrapperSuperfluousCandidates: WrapperSuperfluousCandidateFact[] = []
  const deepNestingCandidates: DeepNestingCandidateFact[] = []
  const emptyCatchNoCommentCandidates: EmptyCatchNoCommentCandidateFact[] = []

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
    visitConstantExpressionCandidates(sf, relPath, constantExpressionCandidates)
    visitTaintedArgumentCandidates(sf, relPath, taintedArgumentCandidates)
    visitTaintedVarsCandidates(sf, relPath, taintedVarDeclCandidates, taintedVarArgCallCandidates)
    visitResourceImbalanceCandidates(sf, relPath, resourceImbalanceCandidates)
    visitSecurityPatternsCandidates(
      sf, relPath,
      secretVarRefCandidates, corsConfigCandidates,
      tlsUnsafeCandidates, weakRandomCandidates,
    )
  }
  // drift-patterns : own narrow regex (no fixtures) — emit unconditionally,
  // legacy aggregator filtre `\.test\.tsx?$|\.spec\.tsx?$|(^|\/)tests?\/`.
  visitDriftPatternsCandidates(
    sf, relPath,
    excessiveOptionalParamsCandidates, wrapperSuperfluousCandidates,
    deepNestingCandidates, emptyCatchNoCommentCandidates,
  )
  // event-listener-sites legacy n'a PAS de filtre test files — capturé même
  // dans tests/ (les tests subscribers comptent).
  visitEventListenerSiteCandidates(sf, relPath, eventListenerSiteCandidates)
  // event-emit-sites idem — pas de filtre test files (legacy).
  visitEventEmitSiteCandidates(sf, relPath, eventEmitSiteCandidates)
  // barrels + import-edges : pas de filtre test files non plus.
  visitBarrelsAndImports(sf, relPath, rootDir, barrelFiles, importEdges)
  // env-usage : capture process.env.X partout (legacy ne filtre pas).
  visitEnvVarReads(sf, relPath, envVarReads)

  return {
    numericLiterals, binaryExpressions, exemptionLines, fileTags,
    callExpressions, functionScopes, functionParams,
    sanitizerCandidates, taintSinkCandidates,
    longFunctionCandidates, functionComplexities,
    hardcodedSecretCandidates,
    eventListenerSiteCandidates,
    barrelFiles, importEdges, envVarReads,
    constantExpressionCandidates,
    taintedArgumentCandidates,
    eventEmitSiteCandidates,
    taintedVarDeclCandidates,
    taintedVarArgCallCandidates,
    resourceImbalanceCandidates,
    secretVarRefCandidates,
    corsConfigCandidates,
    tlsUnsafeCandidates,
    weakRandomCandidates,
    excessiveOptionalParamsCandidates,
    wrapperSuperfluousCandidates,
    deepNestingCandidates,
    emptyCatchNoCommentCandidates,
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

// ─── Barrels + import edges (cross-file resolution) ────────────────────────

function visitBarrelsAndImports(
  sf: SourceFile,
  relPath: string,
  rootDir: string,
  barrelsOut: BarrelFileFact[],
  edgesOut: ImportEdgeFact[],
): void {
  // Import + Export edges resolved via ts-morph
  for (const decl of sf.getImportDeclarations()) {
    const target = decl.getModuleSpecifierSourceFile()
    if (!target) continue
    const toFile = relativizePath(target.getFilePath() as string, rootDir)
    if (toFile) edgesOut.push({ fromFile: relPath, toFile })
  }
  for (const decl of sf.getExportDeclarations()) {
    const target = decl.getModuleSpecifierSourceFile()
    if (!target) continue
    const toFile = relativizePath(target.getFilePath() as string, rootDir)
    if (toFile) edgesOut.push({ fromFile: relPath, toFile })
  }

  // Barrel = TOUS les top-level statements sont des ExportDeclaration avec
  // module specifier. Pas de declaration. Réplique exact legacy.
  const statements = sf.getStatements()
  if (statements.length === 0) return
  let reExports = 0
  for (const stmt of statements) {
    if (stmt.getKind() !== SyntaxKind.ExportDeclaration) return
    const mod = (stmt as unknown as { getModuleSpecifierValue?: () => string | undefined })
      .getModuleSpecifierValue?.()
    if (!mod) return
    reExports++
  }
  if (reExports === 0) return
  barrelsOut.push({ file: relPath, reExportCount: reExports })
}

function relativizePath(absPath: string, rootDir: string): string | null {
  if (!rootDir) return null
  const normalized = absPath.replace(/\\/g, '/')
  const root = rootDir.replace(/\\/g, '/')
  if (!normalized.startsWith(root)) return null
  return normalized.slice(root.length + 1)
}

// ─── Env var reads (process.env.X) ─────────────────────────────────────────

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
  // L'env access doit être à gauche : sinon `default ?? process.env.FOO`
  // signifie que process.env est le default lui-même.
  return parent.getLeft() === node ? 1 : 0
}

function envWrappingCallName(node: Node): string {
  // Remonte au-dessus d'un éventuel `?? 'default'` parent.
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

function visitEnvVarReads(
  sf: SourceFile,
  relPath: string,
  out: EnvVarReadFact[],
): void {
  // Court-circuit textuel — comme legacy.
  const content = sf.getFullText()
  if (!content.includes('process.env')) return

  // Legacy utilise buildLineToSymbol (line→symbol via put-if-absent : indexe
  // FunctionDecl, ClassMethod, et VariableDecl-with-fnLike-init — pas les
  // arrows inline en arg de call comme `app.get('/x', (req, res) => {...})`).
  // → utiliser le SAME helper pour BIT-IDENTICAL parity.
  const lineToSymbol = buildLineToSymbol(sf)

  sf.forEachDescendant((node) => {
    const k = node.getKind()
    if (k === SyntaxKind.PropertyAccessExpression) {
      const obj = (node as import('ts-morph').PropertyAccessExpression).getExpression()
      if (!isProcessEnvNode(obj)) return
      const name = (node as import('ts-morph').PropertyAccessExpression).getName()
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
    } else if (k === SyntaxKind.ElementAccessExpression) {
      const ea = node as import('ts-morph').ElementAccessExpression
      const obj = ea.getExpression()
      if (!isProcessEnvNode(obj)) return
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
  })
}

// ─── Event listener sites (Phase 5 Tier 17) ────────────────────────────────

const EVENT_LISTENER_NAMES = new Set([
  'on', 'once', 'subscribe', 'addEventListener', 'listen', 'listensTo',
])

function visitEventListenerSiteCandidates(
  sf: SourceFile,
  relPath: string,
  out: EventListenerSiteCandidateFact[],
): void {
  // Court-circuit textuel — comme legacy.
  const text = sf.getFullText()
  let hasCandidate = false
  for (const n of EVENT_LISTENER_NAMES) {
    if (text.includes(n + '(') || text.includes('.' + n + '(')) {
      hasCandidate = true
      break
    }
  }
  if (!hasCandidate) return

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression()
    let calleeName = ''
    let isMethodCall = 0
    let receiver = ''
    if (Node.isIdentifier(callee)) {
      calleeName = callee.getText()
    } else if (Node.isPropertyAccessExpression(callee)) {
      calleeName = callee.getName()
      isMethodCall = 1
      receiver = callee.getExpression().getText()
    } else continue
    if (!EVENT_LISTENER_NAMES.has(calleeName)) continue

    const args = call.getArguments()
    if (args.length === 0) continue
    const arg0 = args[0]
    const line = call.getStartLineNumber()
    const symbol = findContainingSymbol(call)
    const fullCalleeText = isMethodCall === 1 && receiver
      ? `${receiver}.${calleeName}` : calleeName

    if (Node.isStringLiteral(arg0) || Node.isNoSubstitutionTemplateLiteral(arg0)) {
      out.push({
        file: relPath, line, symbol, callee: fullCalleeText,
        isMethodCall, receiver,
        kind: 'literal', literalValue: arg0.getLiteralValue(), refExpression: '',
      })
    } else if (Node.isPropertyAccessExpression(arg0)) {
      out.push({
        file: relPath, line, symbol, callee: fullCalleeText,
        isMethodCall, receiver,
        kind: 'eventConstRef', literalValue: '', refExpression: arg0.getText(),
      })
    } else {
      out.push({
        file: relPath, line, symbol, callee: fullCalleeText,
        isMethodCall, receiver,
        kind: 'dynamic', literalValue: '', refExpression: '',
      })
    }
  }
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

// ─── Constant Expressions (visitor pré-classifie) ────────────────────────────

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

function visitConstantExpressionCandidates(
  sf: SourceFile,
  relPath: string,
  out: ConstantExpressionCandidateFact[],
): void {
  // 1. Tautology / contradiction (if + ternary)
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

  // 2. Gratuitous bool comparisons (===/!==/==/!= avec true/false literal)
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

  // 3. Double negation (!!X hors return / as expression / variable decl)
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

  // 4. Literal fold opportunity (X + 0 / 0 + X)
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

// ─── Tainted Arguments (cross-fn taint, Tier 14) ────────────────────────────

type TaintSourceKindStr =
  | 'req.body' | 'req.query' | 'req.params' | 'req.headers'
  | 'process.argv' | 'process.env'

const ARG_SOURCE_PATTERNS: Array<{ kind: TaintSourceKindStr; re: RegExp }> = [
  { kind: 'req.body',     re: /^(req|request|ctx\.req)\.body($|\.|\[)/ },
  { kind: 'req.query',    re: /^(req|request|ctx\.req)\.query($|\.|\[)/ },
  { kind: 'req.params',   re: /^(req|request|ctx\.req)\.params($|\.|\[)/ },
  { kind: 'req.headers',  re: /^(req|request|ctx\.req)\.headers($|\.|\[)/ },
  { kind: 'process.argv', re: /^process\.argv($|\.|\[)/ },
  { kind: 'process.env',  re: /^process\.env($|\.|\[)/ },
]

function matchArgSource(text: string): TaintSourceKindStr | null {
  const t = text.trim()
  for (const { kind, re } of ARG_SOURCE_PATTERNS) {
    if (re.test(t)) return kind
  }
  return null
}

interface ArgFnScope {
  name: string
  fnNode: Node
}

function* iterateArgFnScopes(sf: SourceFile): Generator<ArgFnScope> {
  for (const fn of sf.getFunctions()) {
    const name = fn.getName()
    if (!name) continue
    yield { name, fnNode: fn }
  }
  for (const cls of sf.getClasses()) {
    const className = cls.getName() ?? '(anonymous)'
    for (const method of cls.getMethods()) {
      yield { name: `${className}.${method.getName()}`, fnNode: method }
    }
  }
  for (const v of sf.getVariableDeclarations()) {
    const init = v.getInitializer()
    if (!init) continue
    if (!Node.isArrowFunction(init) && !Node.isFunctionExpression(init)) continue
    yield { name: v.getName(), fnNode: init }
  }
}

function collectArgScopeTaintedVars(fnNode: Node): Map<string, TaintSourceKindStr> {
  const taintedVars = new Map<string, TaintSourceKindStr>()
  for (const v of fnNode.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = v.getInitializer()
    if (!init) continue
    const src = matchArgSource(init.getText())
    if (!src) continue
    const nameNode = v.getNameNode()
    if (!Node.isIdentifier(nameNode)) continue
    taintedVars.set(nameNode.getText(), src)
  }
  return taintedVars
}

function readArgCalleeText(callee: Node): string | null {
  if (Node.isIdentifier(callee)) return callee.getText()
  if (Node.isPropertyAccessExpression(callee)) return callee.getName()
  return null
}

function visitTaintedArgumentCandidates(
  sf: SourceFile,
  relPath: string,
  out: TaintedArgumentCandidateFact[],
): void {
  for (const scope of iterateArgFnScopes(sf)) {
    const taintedVars = collectArgScopeTaintedVars(scope.fnNode)
    for (const call of scope.fnNode.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const calleeText = readArgCalleeText(call.getExpression())
      if (!calleeText) continue
      const args = call.getArguments()
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        const directSrc = matchArgSource(arg.getText())
        if (directSrc) {
          out.push({
            callerFile: relPath, callerSymbol: scope.name,
            callee: calleeText, paramIndex: i, source: directSrc,
          })
          continue
        }
        if (Node.isIdentifier(arg)) {
          const varSrc = taintedVars.get(arg.getText())
          if (varSrc) {
            out.push({
              callerFile: relPath, callerSymbol: scope.name,
              callee: calleeText, paramIndex: i, source: varSrc,
            })
          }
        }
      }
    }
  }
}

// ─── Event Emit Sites (parallèle à event-listener-sites) ────────────────────

const EMIT_NAMES = new Set(['emit', 'emitEvent'])

function visitEventEmitSiteCandidates(
  sf: SourceFile,
  relPath: string,
  out: EventEmitSiteCandidateFact[],
): void {
  // Court-circuit textuel — comme legacy.
  const text = sf.getFullText()
  let hasCandidate = false
  for (const n of EMIT_NAMES) {
    if (text.includes(n + '(')) { hasCandidate = true; break }
  }
  if (!hasCandidate) return

  const lineToSymbol = buildLineToSymbol(sf)
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression()
    let calleeName = ''
    let isMethodCall = 0
    let receiver = ''
    if (Node.isIdentifier(callee)) {
      calleeName = callee.getText()
    } else if (Node.isPropertyAccessExpression(callee)) {
      calleeName = callee.getName()
      isMethodCall = 1
      receiver = callee.getExpression().getText()
    } else continue
    if (!EMIT_NAMES.has(calleeName)) continue

    const args = call.getArguments()
    if (args.length === 0) continue
    const firstArg = args[0]
    if (firstArg.getKind() !== SyntaxKind.ObjectLiteralExpression) continue

    // Find type: prop
    const props = (firstArg as import('ts-morph').ObjectLiteralExpression).getProperties()
    let typeInit: Node | undefined
    for (const p of props) {
      if (p.getKind() !== SyntaxKind.PropertyAssignment) continue
      const pa = p as import('ts-morph').PropertyAssignment
      const nameNode = pa.getNameNode()
      const k = nameNode.getKind()
      let name: string | undefined
      if (k === SyntaxKind.Identifier) name = nameNode.getText()
      else if (k === SyntaxKind.StringLiteral) {
        name = (nameNode as import('ts-morph').StringLiteral).getLiteralText()
      }
      if (name === 'type') {
        typeInit = pa.getInitializer()
        break
      }
    }
    if (!typeInit) continue

    const line = call.getStartLineNumber()
    const symbol = lineToSymbol.get(line) ?? ''
    const initKind = typeInit.getKind()

    if (initKind === SyntaxKind.StringLiteral || initKind === SyntaxKind.NoSubstitutionTemplateLiteral) {
      const lit = typeInit as import('ts-morph').StringLiteral | import('ts-morph').NoSubstitutionTemplateLiteral
      out.push({
        file: relPath, line, symbol,
        callee: calleeName, isMethodCall, receiver,
        kind: 'literal', literalValue: lit.getLiteralText(), refExpression: '',
      })
    } else if (initKind === SyntaxKind.PropertyAccessExpression) {
      out.push({
        file: relPath, line, symbol,
        callee: calleeName, isMethodCall, receiver,
        kind: 'eventConstRef', literalValue: '', refExpression: typeInit.getText(),
      })
    } else {
      out.push({
        file: relPath, line, symbol,
        callee: calleeName, isMethodCall, receiver,
        kind: 'dynamic', literalValue: '', refExpression: '',
      })
    }
  }
}

// ─── Tainted Vars (Tier 11) ─────────────────────────────────────────────────

const TAINTED_VARS_SOURCE_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: 'req.body',     re: /^(req|request|ctx\.req)\.body($|\.|\[)/ },
  { kind: 'req.query',    re: /^(req|request|ctx\.req)\.query($|\.|\[)/ },
  { kind: 'req.params',   re: /^(req|request|ctx\.req)\.params($|\.|\[)/ },
  { kind: 'req.headers',  re: /^(req|request|ctx\.req)\.headers($|\.|\[)/ },
  { kind: 'process.argv', re: /^process\.argv($|\.|\[)/ },
  { kind: 'process.env',  re: /^process\.env($|\.|\[)/ },
]

function matchTaintedVarsSource(text: string): string | null {
  const t = text.trim()
  for (const { kind, re } of TAINTED_VARS_SOURCE_PATTERNS) {
    if (re.test(t)) return kind
  }
  return null
}

interface TaintedVarsFnScope {
  fnNode: Node
  fnId: string
  fnName: string
}

function* iterateTaintedVarsFnScopes(sf: SourceFile): Generator<TaintedVarsFnScope> {
  for (const fn of sf.getFunctions()) {
    const name = fn.getName() ?? '(anonymous)'
    yield { fnNode: fn, fnId: `fn:${name}:${fn.getStartLineNumber()}`, fnName: name }
  }
  for (const cls of sf.getClasses()) {
    const className = cls.getName() ?? '(anonymous)'
    for (const method of cls.getMethods()) {
      const name = `${className}.${method.getName()}`
      yield { fnNode: method, fnId: `mth:${name}:${method.getStartLineNumber()}`, fnName: name }
    }
  }
  for (const v of sf.getVariableDeclarations()) {
    const init = v.getInitializer()
    if (!init) continue
    if (!Node.isArrowFunction(init) && !Node.isFunctionExpression(init)) continue
    const name = v.getName()
    yield { fnNode: init, fnId: `arrow:${name}:${v.getStartLineNumber()}`, fnName: name }
  }
}

function readTaintedVarsCalleeText(callee: Node): string | null {
  if (Node.isIdentifier(callee)) return callee.getText()
  if (Node.isPropertyAccessExpression(callee)) return callee.getText()
  return null
}

function visitTaintedVarsCandidates(
  sf: SourceFile,
  relPath: string,
  declsOut: TaintedVarDeclCandidateFact[],
  argCallsOut: TaintedVarArgCallCandidateFact[],
): void {
  const taintedByFn = new Map<string, Map<string, string>>()
  for (const { fnNode, fnId, fnName } of iterateTaintedVarsFnScopes(sf)) {
    const taintedVars = new Map<string, string>()
    for (const v of fnNode.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const init = v.getInitializer()
      if (!init) continue
      const source = matchTaintedVarsSource(init.getText())
      if (!source) continue
      const nameNode = v.getNameNode()
      const line = v.getStartLineNumber()
      if (Node.isIdentifier(nameNode)) {
        taintedVars.set(nameNode.getText(), source)
        declsOut.push({
          file: relPath, containingSymbol: fnName,
          varName: nameNode.getText(), line, source,
        })
      } else if (Node.isObjectBindingPattern(nameNode) || Node.isArrayBindingPattern(nameNode)) {
        for (const elem of nameNode.getElements()) {
          if (!Node.isBindingElement(elem)) continue
          const elemName = elem.getNameNode()
          if (!Node.isIdentifier(elemName)) continue
          taintedVars.set(elemName.getText(), source)
          declsOut.push({
            file: relPath, containingSymbol: fnName,
            varName: elemName.getText(), line, source,
          })
        }
      }
    }
    if (taintedVars.size > 0) taintedByFn.set(fnId, taintedVars)
  }

  for (const { fnNode, fnId, fnName } of iterateTaintedVarsFnScopes(sf)) {
    const taintedVars = taintedByFn.get(fnId)
    if (!taintedVars) continue
    for (const call of fnNode.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const calleeText = readTaintedVarsCalleeText(call.getExpression())
      if (!calleeText) continue
      const args = call.getArguments()
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (!Node.isIdentifier(arg)) continue
        const varName = arg.getText()
        const source = taintedVars.get(varName)
        if (!source) continue
        argCallsOut.push({
          file: relPath,
          line: call.getStartLineNumber(),
          callee: calleeText,
          argVarName: varName,
          argIndex: i,
          source,
          containingSymbol: fnName,
        })
      }
    }
  }
}

// ─── Resource Balance (Tier 6) ──────────────────────────────────────────────

interface ResourcePairDef { acquire: string; release: string }

const RESOURCE_PAIRS: ResourcePairDef[] = [
  { acquire: 'acquire', release: 'release' },
  { acquire: 'lock', release: 'unlock' },
  { acquire: 'connect', release: 'disconnect' },
  { acquire: 'open', release: 'close' },
  { acquire: 'subscribe', release: 'unsubscribe' },
  { acquire: 'setInterval', release: 'clearInterval' },
  { acquire: 'addEventListener', release: 'removeEventListener' },
]

interface ResourceFnScope { name: string; body: Node | undefined; line: number }

function* iterateResourceFnScopes(sf: SourceFile): Generator<ResourceFnScope> {
  for (const fn of sf.getFunctions()) {
    yield { name: fn.getName() ?? '(anonymous)', body: fn.getBody(), line: fn.getStartLineNumber() }
  }
  for (const cls of sf.getClasses()) {
    const className = cls.getName() ?? '(anonymous)'
    for (const method of cls.getMethods()) {
      yield {
        name: `${className}.${method.getName()}`,
        body: method.getBody(),
        line: method.getStartLineNumber(),
      }
    }
  }
  for (const v of sf.getVariableDeclarations()) {
    const init = v.getInitializer()
    if (!init) continue
    if (!Node.isArrowFunction(init) && !Node.isFunctionExpression(init)) continue
    yield { name: v.getName(), body: init.getBody(), line: v.getStartLineNumber() }
  }
}

function readResourceCalleeName(callee: Node): string | null {
  if (Node.isIdentifier(callee)) return callee.getText()
  if (Node.isPropertyAccessExpression(callee)) return callee.getName()
  return null
}

function visitResourceImbalanceCandidates(
  sf: SourceFile,
  relPath: string,
  out: ResourceImbalanceCandidateFact[],
): void {
  for (const scope of iterateResourceFnScopes(sf)) {
    if (!scope.body) continue
    const counts = new Map<string, number>()
    for (const call of scope.body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const methodName = readResourceCalleeName(call.getExpression())
      if (!methodName) continue
      counts.set(methodName, (counts.get(methodName) ?? 0) + 1)
    }
    for (const pair of RESOURCE_PAIRS) {
      const acq = counts.get(pair.acquire) ?? 0
      const rel = counts.get(pair.release) ?? 0
      if (acq === 0 || rel === 0) continue
      if (acq === rel) continue
      out.push({
        file: relPath,
        containingSymbol: scope.name,
        line: scope.line,
        pair: `${pair.acquire}/${pair.release}`,
        acquireCount: acq,
        releaseCount: rel,
      })
    }
  }
}

// ─── Security Patterns (Tier 16) ────────────────────────────────────────────

const SECURITY_SECRET_NAME_RE =
  /^(password|passwd|pwd|secret|token|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|client[-_]?secret|jwt|nonce|sessionid|csrf|otp|priv(ate)?[-_]?key|encryption[-_]?key)$/i

function detectSecuritySecretKind(name: string): string {
  const m = name.match(SECURITY_SECRET_NAME_RE)
  return m ? m[0].toLowerCase() : ''
}

function isSecurityMathRandomCall(call: Node): boolean {
  if (!Node.isCallExpression(call)) return false
  const callee = call.getExpression()
  return Node.isPropertyAccessExpression(callee)
    && callee.getExpression().getText() === 'Math'
    && callee.getName() === 'random'
}

function classifySecurityCorsOriginKind(init: Node | undefined): string {
  if (!init) return 'dynamic'
  if (Node.isStringLiteral(init)) {
    return init.getLiteralValue() === '*' ? 'wildcard' : 'literal'
  }
  if (Node.isPropertyAccessExpression(init)
    && /req\.headers\.|request\.headers\./.test(init.getText())) {
    return 'reflective'
  }
  return 'dynamic'
}

function visitSecurityPatternsCandidates(
  sf: SourceFile,
  relPath: string,
  secretRefsOut: SecretVarRefCandidateFact[],
  corsOut: CorsConfigCandidateFact[],
  tlsOut: TlsUnsafeCandidateFact[],
  weakRandomsOut: WeakRandomCandidateFact[],
): void {
  // Pass 1: CallExpression — cors({ origin }) + secret refs en args
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const line = call.getStartLineNumber()
    const callee = call.getExpression()
    const args = call.getArguments()

    // CORS detection
    if (Node.isIdentifier(callee) && callee.getText() === 'cors'
      && args.length > 0 && Node.isObjectLiteralExpression(args[0])) {
      const originProp = args[0].getProperty('origin')
      if (originProp && Node.isPropertyAssignment(originProp)) {
        corsOut.push({
          file: relPath, line,
          originKind: classifySecurityCorsOriginKind(originProp.getInitializer()),
          containingSymbol: sharedFindContainingSymbol(call),
        })
      }
    }

    // Secret refs : identifier args + shorthand prop names
    let calleeText = ''
    if (Node.isIdentifier(callee)) calleeText = callee.getText()
    else if (Node.isPropertyAccessExpression(callee)) calleeText = callee.getText()
    if (!calleeText) continue
    for (const arg of args) {
      if (Node.isIdentifier(arg)) {
        const k = detectSecuritySecretKind(arg.getText())
        if (k) {
          secretRefsOut.push({
            file: relPath, line,
            varName: arg.getText(), kind: k, callee: calleeText,
            containingSymbol: sharedFindContainingSymbol(call),
          })
        }
      } else if (Node.isObjectLiteralExpression(arg)) {
        for (const prop of arg.getProperties()) {
          if (!Node.isShorthandPropertyAssignment(prop)) continue
          const name = prop.getName()
          const k = detectSecuritySecretKind(name)
          if (k) {
            secretRefsOut.push({
              file: relPath, line,
              varName: name, kind: k, callee: calleeText,
              containingSymbol: sharedFindContainingSymbol(call),
            })
          }
        }
      }
    }
  }

  // Pass 2: VariableDeclaration → Math.random()
  for (const v of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = v.getInitializer()
    if (!init || !Node.isCallExpression(init)) continue
    if (!isSecurityMathRandomCall(init)) continue
    const nameNode = v.getNameNode()
    const varName = Node.isIdentifier(nameNode) ? nameNode.getText() : ''
    weakRandomsOut.push({
      file: relPath,
      line: v.getStartLineNumber(),
      varName,
      secretKind: detectSecuritySecretKind(varName),
      containingSymbol: sharedFindContainingSymbol(v),
    })
  }

  // Pass 3: ObjectLiteral → TLS unsafe options
  for (const obj of sf.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
    const line = obj.getStartLineNumber()
    for (const prop of obj.getProperties()) {
      if (!Node.isPropertyAssignment(prop)) continue
      const name = prop.getName()
      const init = prop.getInitializer()
      if (!init) continue
      if ((name === 'rejectUnauthorized' || name === 'strictSSL')
        && init.getText() === 'false') {
        tlsOut.push({
          file: relPath, line, key: name,
          containingSymbol: sharedFindContainingSymbol(obj),
        })
      }
    }
  }
}

// ─── Drift Patterns (4 AST patterns ; todo-no-owner non-portable, cross-file) ─

const DRIFT_TEST_FILE_RE = /\.test\.tsx?$|\.spec\.tsx?$|(^|\/)tests?\//
const DRIFT_OPTIONAL_THRESHOLD = 5
const DRIFT_WRAPPER_MIN_ARGS = 1
const DRIFT_MAX_NESTING_DEPTH = 5

const DRIFT_NESTING_KINDS = new Set<SyntaxKind>([
  SyntaxKind.IfStatement,
  SyntaxKind.ForStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.SwitchStatement,
  SyntaxKind.TryStatement,
])

interface DriftFnLikeNode {
  name: string
  body: Node | undefined
  line: number
  paramNames: string[]
  optionalCount: number
  fnKind: 'function' | 'method' | 'arrow'
}

function* iterateDriftFnLikes(sf: SourceFile): Generator<DriftFnLikeNode> {
  for (const fn of sf.getFunctions()) {
    const params = fn.getParameters()
    yield {
      name: fn.getName() ?? '(anonymous)',
      body: fn.getBody(),
      line: fn.getStartLineNumber(),
      paramNames: params.map((p) => p.getName()),
      optionalCount: params.filter((p) => p.isOptional()).length,
      fnKind: 'function',
    }
  }
  for (const cls of sf.getClasses()) {
    const className = cls.getName() ?? '(anonymous)'
    for (const method of cls.getMethods()) {
      const params = method.getParameters()
      yield {
        name: `${className}.${method.getName()}`,
        body: method.getBody(),
        line: method.getStartLineNumber(),
        paramNames: params.map((p) => p.getName()),
        optionalCount: params.filter((p) => p.isOptional()).length,
        fnKind: 'method',
      }
    }
  }
  for (const v of sf.getVariableDeclarations()) {
    const init = v.getInitializer()
    if (!init) continue
    if (!Node.isArrowFunction(init) && !Node.isFunctionExpression(init)) continue
    const params = init.getParameters()
    yield {
      name: v.getName(),
      body: init.getBody(),
      line: v.getStartLineNumber(),
      paramNames: params.map((p) => p.getName()),
      optionalCount: params.filter((p) => p.isOptional()).length,
      fnKind: 'arrow',
    }
  }
}

function driftSingleReturnExpr(body: Node): Node | null {
  if (Node.isBlock(body)) {
    const stmts = body.getStatements()
    if (stmts.length !== 1) return null
    const stmt = stmts[0]
    if (!Node.isReturnStatement(stmt)) return null
    return stmt.getExpression() ?? null
  }
  return body
}

function driftArgsMatchParamsExactly(args: Node[], paramNames: string[]): boolean {
  if (args.length !== paramNames.length) return false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!Node.isIdentifier(arg)) return false
    if (arg.getText() !== paramNames[i]) return false
  }
  return true
}

function driftComputeMaxNestingDepth(body: Node): number {
  let maxDepth = 0
  const walk = (n: Node, depth: number): void => {
    if (DRIFT_NESTING_KINDS.has(n.getKind())) {
      depth++
      if (depth > maxDepth) maxDepth = depth
    }
    n.forEachChild((child) => walk(child, depth))
  }
  walk(body, 0)
  return maxDepth
}

function visitDriftPatternsCandidates(
  sf: SourceFile,
  relPath: string,
  optParamsOut: ExcessiveOptionalParamsCandidateFact[],
  wrapperOut: WrapperSuperfluousCandidateFact[],
  deepNestingOut: DeepNestingCandidateFact[],
  emptyCatchOut: EmptyCatchNoCommentCandidateFact[],
): void {
  if (DRIFT_TEST_FILE_RE.test(relPath)) return

  for (const fn of iterateDriftFnLikes(sf)) {
    if (fn.optionalCount > DRIFT_OPTIONAL_THRESHOLD) {
      optParamsOut.push({
        file: relPath, line: fn.line,
        name: fn.name, fnKind: fn.fnKind, optionalCount: fn.optionalCount,
      })
    }
    if (fn.body && fn.paramNames.length >= DRIFT_WRAPPER_MIN_ARGS) {
      const ret = driftSingleReturnExpr(fn.body)
      if (ret && Node.isCallExpression(ret)
        && driftArgsMatchParamsExactly(ret.getArguments(), fn.paramNames)) {
        wrapperOut.push({
          file: relPath, line: fn.line,
          name: fn.name, fnKind: fn.fnKind,
          callee: ret.getExpression().getText(),
        })
      }
    }
    if (fn.body) {
      const maxDepth = driftComputeMaxNestingDepth(fn.body)
      if (maxDepth > DRIFT_MAX_NESTING_DEPTH) {
        deepNestingOut.push({
          file: relPath, line: fn.line,
          name: fn.name, maxDepth,
        })
      }
    }
  }

  for (const cat of sf.getDescendantsOfKind(SyntaxKind.CatchClause)) {
    const block = cat.getBlock()
    if (block.getStatements().length > 0) continue
    if (/\/\/|\/\*/.test(block.getFullText())) continue
    emptyCatchOut.push({
      file: relPath,
      line: cat.getStartLineNumber(),
    })
  }
}
