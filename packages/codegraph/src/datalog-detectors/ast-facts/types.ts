// ADR-024 — Fact tuple types pour le visitor AST
/**
 * Toutes les interfaces de tuples émis par les visitors. Centralisé pour
 * éviter circular imports entre orchestrator et visitors. Les visitors
 * importent uniquement les types qu'ils émettent ; l'orchestrator
 * importe `AstFactsBundle`.
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
  isTrivial: number
}

export interface BinaryExpressionFact {
  file: string
  line: number
  op: string
  leftText: string
  rightText: string
  leftIsShortLiteral: number
}

export interface ExemptionLineFact {
  file: string
  line: number
  marker: string
}

export interface FileTagFact {
  file: string
  tag: string
}

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

export interface FunctionScopeFact {
  file: string
  line: number
  name: string
  totalParams: number
  nameMatchesSetterPredicate: number
}

export interface FunctionParamFact {
  file: string
  scopeLine: number
  paramIndex: number
  paramName: string
  typeText: string
}

export interface SanitizerCandidateFact {
  file: string
  line: number
  callee: string
  containingSymbol: string
}

export interface TaintSinkCandidateFact {
  file: string
  line: number
  kind: string
  callee: string
  containingSymbol: string
}

export interface LongFunctionCandidateFact {
  file: string
  line: number
  name: string
  loc: number
  kind: 'function' | 'method' | 'arrow'
}

export interface FunctionComplexityFact {
  file: string
  line: number
  name: string
  cyclomatic: number
  cognitive: number
  containingClass: string
}

export interface BarrelFileFact {
  file: string
  reExportCount: number
}

export interface ImportEdgeFact {
  fromFile: string
  toFile: string
}

export interface EnvVarReadFact {
  file: string
  line: number
  col: number
  varName: string
  symbol: string
  hasDefault: number
  wrappedIn: string
}

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

export interface HardcodedSecretCandidateFact {
  file: string
  line: number
  varOrPropName: string
  sample: string
  entropyX1000: number
  length: number
  trigger: 'name' | 'pattern'
}

export interface RegexLiteralCandidateFact {
  file: string
  line: number
  source: string
  flags: string
  hasNestedQuantifier: number
}

export interface TryCatchSwallowCandidateFact {
  file: string
  line: number
  kind: string
  containingSymbol: string
}

export interface AwaitInLoopCandidateFact {
  file: string
  line: number
  loopKind: string
  containingSymbol: string
}

export interface AllocationInLoopCandidateFact {
  file: string
  line: number
  allocKind: string
  containingSymbol: string
}

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

export interface ResourceImbalanceCandidateFact {
  file: string
  containingSymbol: string
  line: number
  pair: string
  acquireCount: number
  releaseCount: number
}

export interface TaintedVarDeclCandidateFact {
  file: string
  containingSymbol: string
  varName: string
  line: number
  source: string
}

export interface TaintedVarArgCallCandidateFact {
  file: string
  line: number
  callee: string
  argVarName: string
  argIndex: number
  source: string
  containingSymbol: string
}

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

export interface TaintedArgumentCandidateFact {
  callerFile: string
  callerSymbol: string
  callee: string
  paramIndex: number
  source: string
}

export interface ConstantExpressionCandidateFact {
  file: string
  line: number
  kind: string
  message: string
  exprRepr: string
}

/**
 * ADR-026 phase A.4.2 : DeadCodeFinding[] délégué via legacy
 * `extractDeadCodeFileBundle` pour parité 100% sur les 6 sub-kinds.
 */
export interface DeadCodeFindingFact {
  kind: 'identical-subexpressions' | 'return-then-else' | 'switch-fallthrough'
    | 'switch-no-default' | 'switch-empty' | 'controlling-expression-constant'
  file: string
  line: number
  message: string
  details?: Record<string, string | number | boolean>
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
  regexLiteralCandidates: RegexLiteralCandidateFact[]
  tryCatchSwallowCandidates: TryCatchSwallowCandidateFact[]
  awaitInLoopCandidates: AwaitInLoopCandidateFact[]
  allocationInLoopCandidates: AllocationInLoopCandidateFact[]
  deadCodeFindings: DeadCodeFindingFact[]
}
