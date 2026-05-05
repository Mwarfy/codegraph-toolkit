import { type SourceFile, Node, SyntaxKind } from 'ts-morph'
import type {
  ExcessiveOptionalParamsCandidateFact,
  WrapperSuperfluousCandidateFact,
  DeepNestingCandidateFact,
  EmptyCatchNoCommentCandidateFact,
} from './types.js'

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

export function visitDriftPatternsCandidates(
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
