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

.decl TimeoutFnName(name:symbol)
.input TimeoutFnName
.decl TimeoutPropertyName(name:symbol)
.input TimeoutPropertyName
.decl ThresholdPropertyName(name:symbol)
.input ThresholdPropertyName
.decl SuspectBinaryOp(op:symbol)
.input SuspectBinaryOp

.decl MagicNumber(file:symbol, line:number, valueText:symbol, context:symbol, category:symbol)
.output MagicNumber

.decl DeadCode(file:symbol, line:number, kind:symbol, message:symbol, op:symbol, expr:symbol)
.output DeadCode
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

// Rule 8 — binary comparison \`x > 5000\` etc. parentName = "compare <op>"
// déjà précomputé par le visitor (filtre comparison_ops).
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

export const ALL_RULES_DL = [SCHEMA_DL, MAGIC_NUMBERS_DL, DEAD_CODE_IDENTICAL_DL].join('\n')
