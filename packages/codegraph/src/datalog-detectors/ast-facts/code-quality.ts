import { type SourceFile, Node, SyntaxKind } from 'ts-morph'
import { findContainingSymbol } from '../../extractors/_shared/ast-helpers.js'
import type {
  RegexLiteralCandidateFact,
  TryCatchSwallowCandidateFact,
  AwaitInLoopCandidateFact,
  AllocationInLoopCandidateFact,
} from './types.js'

const CQ_NESTED_QUANTIFIER_RE = /\([^)]*[+*]\)[+*]/
const CQ_LOG_CALL_RE = /(?:console|logger|log)\.[a-z]+\s*\(/i
const CQ_THROW_RE = /throw\s/

const CQ_LOOP_KINDS = new Set<SyntaxKind>([
  SyntaxKind.ForStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
])
const CQ_FN_KINDS = new Set<SyntaxKind>([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
])

function cqFindEnclosingLoop(node: Node): Node | null {
  let cur: Node | undefined = node.getParent()
  while (cur) {
    if (CQ_FN_KINDS.has(cur.getKind())) return null
    if (CQ_LOOP_KINDS.has(cur.getKind())) return cur
    cur = cur.getParent()
  }
  return null
}

function cqIsDescendantOfLoopInit(node: Node, loopAncestor: Node): boolean {
  let cur: Node | undefined = node
  while (cur && cur !== loopAncestor) {
    if (cur.getKind() === SyntaxKind.Block) return false
    cur = cur.getParent()
  }
  return cur === loopAncestor
}

function cqClassifyCatchSwallow(catchClause: import('ts-morph').CatchClause): string | null {
  const block = catchClause.getBlock()
  const stmts = block.getStatements()

  if (stmts.length === 0) {
    const inside = block.getText().slice(1, -1).trim()
    const intentional = /\/\*[\s\S]{3,}\*\//.test(inside) || /\/\/.{3,}/.test(inside)
    return intentional ? null : 'empty'
  }
  let allLog = true
  let hasRethrow = false
  for (const stmt of stmts) {
    const t = stmt.getText()
    if (CQ_THROW_RE.test(t)) hasRethrow = true
    if (!CQ_LOG_CALL_RE.test(t) && !CQ_THROW_RE.test(t)) allLog = false
  }
  if (hasRethrow) return null
  return allLog ? 'log-only' : 'no-rethrow'
}

function collectCqRegexLiterals(
  sf: SourceFile,
  relPath: string,
  regexOut: RegexLiteralCandidateFact[],
): void {
  for (const node of sf.getDescendantsOfKind(SyntaxKind.RegularExpressionLiteral)) {
    const text = node.getText()
    const m = text.match(/^\/(.*)\/([a-z]*)$/)
    if (!m) continue
    regexOut.push({
      file: relPath,
      line: node.getStartLineNumber(),
      source: m[1],
      flags: m[2],
      hasNestedQuantifier: CQ_NESTED_QUANTIFIER_RE.test(m[1]) ? 1 : 0,
    })
  }
}

function collectCqRegexConstructors(
  sf: SourceFile,
  relPath: string,
  regexOut: RegexLiteralCandidateFact[],
): void {
  for (const newExpr of sf.getDescendantsOfKind(SyntaxKind.NewExpression)) {
    const callee = newExpr.getExpression()
    if (!Node.isIdentifier(callee) || callee.getText() !== 'RegExp') continue
    const args = newExpr.getArguments()
    if (args.length === 0) continue
    const arg0 = args[0]
    if (!Node.isStringLiteral(arg0) && !Node.isNoSubstitutionTemplateLiteral(arg0)) continue
    const source = arg0.getLiteralValue()
    const arg1 = args[1]
    let flags = ''
    if (arg1 && (Node.isStringLiteral(arg1) || Node.isNoSubstitutionTemplateLiteral(arg1))) {
      flags = arg1.getLiteralValue()
    }
    regexOut.push({
      file: relPath,
      line: newExpr.getStartLineNumber(),
      source,
      flags,
      hasNestedQuantifier: CQ_NESTED_QUANTIFIER_RE.test(source) ? 1 : 0,
    })
  }
}

function collectCqTryCatchSwallows(
  sf: SourceFile,
  relPath: string,
  catchOut: TryCatchSwallowCandidateFact[],
): void {
  for (const tryStmt of sf.getDescendantsOfKind(SyntaxKind.TryStatement)) {
    const catchClause = tryStmt.getCatchClause()
    if (!catchClause) continue
    const kind = cqClassifyCatchSwallow(catchClause)
    if (!kind) continue
    catchOut.push({
      file: relPath,
      line: tryStmt.getStartLineNumber(),
      kind,
      containingSymbol: findContainingSymbol(tryStmt),
    })
  }
}

function collectCqAwaitInLoops(
  sf: SourceFile,
  relPath: string,
  awaitOut: AwaitInLoopCandidateFact[],
): void {
  for (const awaitNode of sf.getDescendantsOfKind(SyntaxKind.AwaitExpression)) {
    const loop = cqFindEnclosingLoop(awaitNode)
    if (!loop) continue
    awaitOut.push({
      file: relPath,
      line: awaitNode.getStartLineNumber(),
      loopKind: SyntaxKind[loop.getKind()] ?? 'unknown',
      containingSymbol: findContainingSymbol(awaitNode),
    })
  }
}

const CQ_ALLOC_CANDIDATES: Array<{ kind: SyntaxKind; alias: string }> = [
  { kind: SyntaxKind.ArrayLiteralExpression, alias: 'array-literal' },
  { kind: SyntaxKind.ObjectLiteralExpression, alias: 'object-literal' },
  { kind: SyntaxKind.NewExpression, alias: 'new-expression' },
]

function isCqAllocationInLoopFact(
  node: Node,
  alias: string,
): { loopAncestor: Node } | null {
  const loopAncestor = cqFindEnclosingLoop(node)
  if (!loopAncestor) return null
  if (alias === 'object-literal' && node.getFirstAncestorByKind(SyntaxKind.TypeReference)) return null
  if (cqIsDescendantOfLoopInit(node, loopAncestor)) return null
  return { loopAncestor }
}

function collectCqAllocationsInLoops(
  sf: SourceFile,
  relPath: string,
  allocOut: AllocationInLoopCandidateFact[],
): void {
  for (const cand of CQ_ALLOC_CANDIDATES) {
    for (const node of sf.getDescendantsOfKind(cand.kind)) {
      if (!isCqAllocationInLoopFact(node, cand.alias)) continue
      allocOut.push({
        file: relPath,
        line: node.getStartLineNumber(),
        allocKind: cand.alias,
        containingSymbol: findContainingSymbol(node),
      })
    }
  }
}

export function visitCodeQualityPatternsCandidates(
  sf: SourceFile,
  relPath: string,
  regexOut: RegexLiteralCandidateFact[],
  catchOut: TryCatchSwallowCandidateFact[],
  awaitOut: AwaitInLoopCandidateFact[],
  allocOut: AllocationInLoopCandidateFact[],
): void {
  collectCqRegexLiterals(sf, relPath, regexOut)
  collectCqRegexConstructors(sf, relPath, regexOut)
  collectCqTryCatchSwallows(sf, relPath, catchOut)
  collectCqAwaitInLoops(sf, relPath, awaitOut)
  collectCqAllocationsInLoops(sf, relPath, allocOut)
}
