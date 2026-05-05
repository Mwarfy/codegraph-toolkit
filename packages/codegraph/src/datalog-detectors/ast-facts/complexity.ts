import { type SourceFile, type Node, SyntaxKind } from 'ts-morph'
import { computeCyclomatic, computeCognitive } from '../../extractors/_shared/complexity.js'
import type { LongFunctionCandidateFact, FunctionComplexityFact } from './types.js'

interface FnLikeWithBody {
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
    const initKind = init.getKind()
    if (initKind !== SyntaxKind.ArrowFunction && initKind !== SyntaxKind.FunctionExpression) continue
    const body = (init as import('ts-morph').ArrowFunction | import('ts-morph').FunctionExpression).getBody()
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

export function visitLongFunctionAndComplexityCandidates(
  sf: SourceFile,
  relPath: string,
  longOut: LongFunctionCandidateFact[],
  cmplxOut: FunctionComplexityFact[],
): void {
  for (const fn of iterateFnLikesWithBody(sf)) {
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
