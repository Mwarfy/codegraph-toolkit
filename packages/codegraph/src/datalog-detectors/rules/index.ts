// Rules embedded as TS strings — évite de copier les .dl dans dist/.
// Convention Datalog : variables capitalisées, lookup tables littéraux.

export const SCHEMA_DL = `// AST primitive facts — extraits par ast-facts-visitor.ts

.decl NumericLiteralAst(
  file:symbol, line:number, valueText:symbol, valueAbs:number,
  parentKind:symbol, parentName:symbol, parentArgIdx:number,
  isScreamingSnake:number, isRatio:number, isTrivial:number)
.input NumericLiteralAst

.decl BinaryExpressionAst(
  file:symbol, line:number, op:symbol, leftText:symbol, rightText:symbol,
  leftIsShortLiteral:number)
.input BinaryExpressionAst

.decl ExemptionLine(file:symbol, line:number, marker:symbol)
.input ExemptionLine

.decl FileTag(file:symbol, tag:symbol)
.input FileTag

.decl CallExpressionAst(
  file:symbol, line:number,
  calleeKind:symbol, calleeName:symbol, calleeObjectLast:symbol,
  firstArgKind:symbol, firstArgValue:symbol,
  isNew:number, containingSymbol:symbol)
.input CallExpressionAst

.decl FunctionScope(
  file:symbol, line:number, name:symbol,
  totalParams:number, nameMatchesSetterPredicate:number)
.input FunctionScope

.decl FunctionParam(
  file:symbol, scopeLine:number, paramIndex:number,
  paramName:symbol, typeText:symbol)
.input FunctionParam

// ─── Lookup tables ────────────────────────────────────────────────────────

.decl TimeoutFnName(name:symbol)
.input TimeoutFnName
.decl TimeoutPropertyName(name:symbol)
.input TimeoutPropertyName
.decl ThresholdPropertyName(name:symbol)
.input ThresholdPropertyName
.decl SuspectBinaryOp(op:symbol)
.input SuspectBinaryOp
.decl CryptoMethodName(name:symbol)
.input CryptoMethodName
.decl CryptoObjectLast(name:symbol)
.input CryptoObjectLast
.decl BooleanParamTypeText(text:symbol)
.input BooleanParamTypeText

// ─── Output relations ─────────────────────────────────────────────────────

.decl MagicNumber(file:symbol, line:number, valueText:symbol, context:symbol, category:symbol)
.output MagicNumber

.decl DeadCode(file:symbol, line:number, kind:symbol, message:symbol, op:symbol, expr:symbol)
.output DeadCode

.decl EvalCall(file:symbol, line:number, kind:symbol, containingSymbol:symbol)
.output EvalCall

.decl CryptoCall(
  file:symbol, line:number, fn:symbol, algo:symbol, containingSymbol:symbol)
.output CryptoCall

.decl BooleanParamSiteOut(
  file:symbol, scopeName:symbol, scopeLine:number,
  paramIndex:number, paramName:symbol, totalParams:number)
.output BooleanParamSiteOut
`

// Convention engine : variables capitalisées, literals (numbers, strings) inline.
// Booleans 0/1 pin'd directement dans l'atom (parser n'accepte pas '=' constraint).
export const MAGIC_NUMBERS_DL = `
MagicNumber(F, L, V, CallName, "timeout") :-
  NumericLiteralAst(F, L, V, _, "CallExpression", CallName, _, _, _, 0),
  TimeoutFnName(CallName),
  !FileTag(F, "test").

MagicNumber(F, L, V, CtxName, "large-int") :-
  NumericLiteralAst(F, L, V, ValueAbs, "CallExpression", CtxName, _, _, _, 0),
  !TimeoutFnName(CtxName),
  ValueAbs >= 1000,
  !FileTag(F, "test").

MagicNumber(F, L, V, P, "timeout") :-
  NumericLiteralAst(F, L, V, _, "PropertyAssignment", P, _, _, _, 0),
  TimeoutPropertyName(P),
  !FileTag(F, "test").

MagicNumber(F, L, V, P, "threshold") :-
  NumericLiteralAst(F, L, V, _, "PropertyAssignment", P, _, _, _, 0),
  ThresholdPropertyName(P),
  !TimeoutPropertyName(P),
  !FileTag(F, "test").

MagicNumber(F, L, V, P, "ratio") :-
  NumericLiteralAst(F, L, V, _, "PropertyAssignment", P, _, _, 1, 0),
  !TimeoutPropertyName(P),
  !ThresholdPropertyName(P),
  !FileTag(F, "test").

MagicNumber(F, L, V, P, "large-int") :-
  NumericLiteralAst(F, L, V, ValueAbs, "PropertyAssignment", P, _, _, 0, 0),
  !TimeoutPropertyName(P),
  !ThresholdPropertyName(P),
  ValueAbs >= 1000,
  !FileTag(F, "test").

MagicNumber(F, L, V, Name, "large-int") :-
  NumericLiteralAst(F, L, V, ValueAbs, "VariableDeclaration", Name, _, 0, _, 0),
  ValueAbs >= 1000,
  !FileTag(F, "test").

MagicNumber(F, L, V, ParentName, "large-int") :-
  NumericLiteralAst(F, L, V, ValueAbs, "BinaryExpression", ParentName, _, _, _, 0),
  ValueAbs >= 1000,
  !FileTag(F, "test").
`

export const DEAD_CODE_IDENTICAL_DL = `
DeadCode(F, L, "identical-subexpressions",
  "expression avec les 2 cotes identiques — bug ou redondance", Op, Left) :-
    BinaryExpressionAst(F, L, Op, Left, Left, 0),
    SuspectBinaryOp(Op),
    !FileTag(F, "test"),
    !ExemptionLine(F, L, "dead-code-ok").
`

// ─── eval-calls : eval(...) + new Function(...) ───────────────────────────
// CallExpression with calleeKind=Identifier, calleeName="eval", isNew=0
// NewExpression with calleeKind=Identifier, calleeName="Function", isNew=1
export const EVAL_CALLS_DL = `
EvalCall(F, L, "eval", Sym) :-
  CallExpressionAst(F, L, "Identifier", "eval", _, _, _, 0, Sym),
  !FileTag(F, "test").

EvalCall(F, L, "function-constructor", Sym) :-
  CallExpressionAst(F, L, "Identifier", "Function", _, _, _, 1, Sym),
  !FileTag(F, "test").
`

// ─── crypto-algo : crypto.createHash(...) etc. ────────────────────────────
// PropertyAccess callee, calleeName ∈ CryptoMethodName, calleeObjectLast=crypto.
// Algo = firstArgValue (lowercased en visitor) si firstArgKind=string.
export const CRYPTO_ALGO_DL = `
CryptoCall(F, L, MethodName, Algo, Sym) :-
  CallExpressionAst(F, L, "PropertyAccess", MethodName, "crypto", "string", Algo, 0, Sym),
  CryptoMethodName(MethodName),
  !FileTag(F, "test"),
  !ExemptionLine(F, L, "crypto-ok").

// Cas où le premier arg n'est pas une string literal (variable, expr) → algo="".
CryptoCall(F, L, MethodName, "", Sym) :-
  CallExpressionAst(F, L, "PropertyAccess", MethodName, "crypto", FirstKind, _, 0, Sym),
  CryptoMethodName(MethodName),
  FirstKind != "string",
  !FileTag(F, "test"),
  !ExemptionLine(F, L, "crypto-ok").
`

// ─── boolean-params : function-likes avec param boolean strict ─────────────
// Skip si totalParams=1 ET name match setter/predicate. Skip exempt.
// totalParams=1 → règle A pinée (nameMatchesSetterPredicate=0)
// totalParams>=2 → règle B (constraint TotalParams != 1)
export const BOOLEAN_PARAMS_DL = `
BooleanParamSiteOut(F, ScopeName, ScopeLine, Idx, ParamName, 1) :-
  FunctionScope(F, ScopeLine, ScopeName, 1, 0),
  FunctionParam(F, ScopeLine, Idx, ParamName, TypeText),
  BooleanParamTypeText(TypeText),
  !FileTag(F, "test"),
  !ExemptionLine(F, ScopeLine, "boolean-ok").

BooleanParamSiteOut(F, ScopeName, ScopeLine, Idx, ParamName, Total) :-
  FunctionScope(F, ScopeLine, ScopeName, Total, _),
  FunctionParam(F, ScopeLine, Idx, ParamName, TypeText),
  BooleanParamTypeText(TypeText),
  Total >= 2,
  !FileTag(F, "test"),
  !ExemptionLine(F, ScopeLine, "boolean-ok").
`

export const ALL_RULES_DL = [
  SCHEMA_DL,
  MAGIC_NUMBERS_DL,
  DEAD_CODE_IDENTICAL_DL,
  EVAL_CALLS_DL,
  CRYPTO_ALGO_DL,
  BOOLEAN_PARAMS_DL,
].join('\n')
