/**
 * Code Quality Patterns — extracteur deterministe AST (Phase 5 Tier 17).
 *
 * Bundle 3 patterns captures en un seul AST walk :
 *
 *   1. RegexLiteral — capture `RegExpLiteral` + `new RegExp(literal)`
 *      avec source string + flags. Permet une rule ReDoS detectant
 *      les nested quantifiers `(.+)+`, `(a|a)*`.
 *
 *   2. TryCatchSwallow — try/catch dont le block catch est vide ou
 *      contient seulement un log sans rethrow. Source des erreurs
 *      silencieuses.
 *
 *   3. AwaitInLoop — `await` dans un for/while/do/forOf direct (pas
 *      dans une fn nested). Sequential I/O bottleneck — souvent
 *      symptome qu'un Promise.all() ferait mieux.
 */

import { type Project, type SourceFile, Node, SyntaxKind } from 'ts-morph'

const TEST_FILE_RE = /(\.test\.tsx?|\.spec\.tsx?|(^|\/)tests?\/|(^|\/)fixtures?\/)/

export interface RegexLiteralFact {
  file: string
  line: number
  source: string
  flags: string
  /** True ssi le source contient un nested quantifier (heuristique simple). */
  hasNestedQuantifier: boolean
}

export interface TryCatchSwallowFact {
  file: string
  line: number
  /** Kind du catch : 'empty' | 'log-only' | 'no-rethrow' */
  kind: string
  containingSymbol: string
}

export interface AwaitInLoopFact {
  file: string
  line: number
  loopKind: string
  containingSymbol: string
}

export interface AllocationInLoopFact {
  file: string
  line: number
  /** Kind d'allocation : 'array-literal' | 'object-literal' | 'new-expression' | 'spread' */
  allocKind: string
  containingSymbol: string
}

export interface CodeQualityPatternsBundle {
  regexLiterals: RegexLiteralFact[]
  tryCatchSwallows: TryCatchSwallowFact[]
  awaitInLoops: AwaitInLoopFact[]
  allocationInLoops: AllocationInLoopFact[]
}

// Heuristique nested quantifier : detecte (X+)+, (X*)*, (X+|X+)+, etc.
// Pas un parseur regex propre — assez pour les cas catastrophic
// backtracking classiques.
const NESTED_QUANTIFIER_RE = /\([^)]*[+*]\)[+*?]/

export function extractCodeQualityPatternsFileBundle(
  sf: SourceFile,
  relPath: string,
): CodeQualityPatternsBundle {
  const out: CodeQualityPatternsBundle = {
    regexLiterals: [], tryCatchSwallows: [], awaitInLoops: [],
    allocationInLoops: [],
  }
  if (TEST_FILE_RE.test(relPath)) return out

  const lines = sf.getFullText().split('\n')
  const isExempt = (line: number, marker: string): boolean => {
    if (line < 2 || line - 2 >= lines.length) return false
    return new RegExp(`//\\s*${marker}\\b`).test(lines[line - 2])
  }

  // Pass 1 : RegexLiteral
  for (const node of sf.getDescendantsOfKind(SyntaxKind.RegularExpressionLiteral)) {
    const line = node.getStartLineNumber()
    if (isExempt(line, 'regex-ok')) continue
    const text = node.getText()
    const m = text.match(/^\/(.*)\/([a-z]*)$/)
    if (!m) continue
    const source = m[1]
    const flags = m[2]
    out.regexLiterals.push({
      file: relPath, line, source, flags,
      hasNestedQuantifier: NESTED_QUANTIFIER_RE.test(source),
    })
  }
  // Aussi : new RegExp("literal", "flags")
  for (const newExpr of sf.getDescendantsOfKind(SyntaxKind.NewExpression)) {
    const callee = newExpr.getExpression()
    if (!Node.isIdentifier(callee) || callee.getText() !== 'RegExp') continue
    const line = newExpr.getStartLineNumber()
    if (isExempt(line, 'regex-ok')) continue
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
    out.regexLiterals.push({
      file: relPath, line, source, flags,
      hasNestedQuantifier: NESTED_QUANTIFIER_RE.test(source),
    })
  }

  // Pass 2 : TryCatchSwallow
  for (const tryStmt of sf.getDescendantsOfKind(SyntaxKind.TryStatement)) {
    const line = tryStmt.getStartLineNumber()
    if (isExempt(line, 'catch-ok')) continue
    const catchClause = tryStmt.getCatchClause()
    if (!catchClause) continue
    const block = catchClause.getBlock()
    const stmts = block.getStatements()
    let kind = ''
    if (stmts.length === 0) {
      kind = 'empty'
    } else {
      // Check if all statements are log-only and no rethrow
      let allLog = true
      let hasRethrow = false
      for (const stmt of stmts) {
        const t = stmt.getText()
        if (/throw\s/.test(t)) hasRethrow = true
        // rough: log-only if matches console./logger./log.
        if (!/(?:console|logger|log)\.[a-z]+\s*\(/i.test(t) && !/throw\s/.test(t)) {
          allLog = false
        }
      }
      if (hasRethrow) {
        // OK: rethrows. Skip.
      } else if (allLog) {
        kind = 'log-only'
      } else {
        kind = 'no-rethrow'
      }
    }
    if (!kind) continue
    out.tryCatchSwallows.push({
      file: relPath, line, kind,
      containingSymbol: findContainingSymbol(tryStmt),
    })
  }

  // Pass 3 : AwaitInLoop
  // Pour chaque AwaitExpression, on remonte les ancestors jusqu'a une
  // function-like — si on rencontre un loop AVANT une function, c'est
  // un await-in-loop direct.
  const LOOP_KINDS = new Set([
    SyntaxKind.ForStatement,
    SyntaxKind.ForInStatement,
    SyntaxKind.ForOfStatement,
    SyntaxKind.WhileStatement,
    SyntaxKind.DoStatement,
  ])
  const FN_KINDS = new Set([
    SyntaxKind.FunctionDeclaration,
    SyntaxKind.FunctionExpression,
    SyntaxKind.ArrowFunction,
    SyntaxKind.MethodDeclaration,
  ])
  for (const await_ of sf.getDescendantsOfKind(SyntaxKind.AwaitExpression)) {
    const line = await_.getStartLineNumber()
    if (isExempt(line, 'await-ok')) continue
    let cur: Node | undefined = await_.getParent()
    let loopKind: string | null = null
    while (cur) {
      if (FN_KINDS.has(cur.getKind())) break
      if (LOOP_KINDS.has(cur.getKind())) {
        loopKind = SyntaxKind[cur.getKind()] ?? 'unknown'
        break
      }
      cur = cur.getParent()
    }
    if (loopKind) {
      out.awaitInLoops.push({
        file: relPath, line, loopKind,
        containingSymbol: findContainingSymbol(await_),
      })
    }
  }

  // Pass 4 : Allocations in loops (GC pressure marker)
  // Capture les allocations syntheticement creees par iteration :
  //   `[]`, `{}`, `new X(...)`, `[...src]`, `{...src}` dans un loop direct.
  // Filtre : skip si l'allocation est INITIALIZER d'un binding qui sort
  // du scope de la loop (declaration outside-init pattern accepte).
  const allocCandidates: Array<{ kind: number; alias: string }> = [
    { kind: SyntaxKind.ArrayLiteralExpression, alias: 'array-literal' },
    { kind: SyntaxKind.ObjectLiteralExpression, alias: 'object-literal' },
    { kind: SyntaxKind.NewExpression, alias: 'new-expression' },
  ]
  for (const candidate of allocCandidates) {
    for (const node of sf.getDescendantsOfKind(candidate.kind)) {
      const line = node.getStartLineNumber()
      if (isExempt(line, 'alloc-ok')) continue
      // Walk up : si on rencontre une LoopKind avant une FN_KINDS, c'est dans un loop
      let cur: Node | undefined = node.getParent()
      let inLoop = false
      while (cur) {
        if (FN_KINDS.has(cur.getKind())) break
        if (LOOP_KINDS.has(cur.getKind())) { inLoop = true; break }
        cur = cur.getParent()
      }
      if (!inLoop) continue
      // Skip object literal qui ne fait que servir d'arg destructure typing
      // (`function f({a}: {a: number})` peut matcher si parsing genere un ObjectLiteral
      // dans le type — sanity check : on skip les ObjectLiteral dans TypeNode).
      if (candidate.alias === 'object-literal'
       && node.getFirstAncestorByKind(SyntaxKind.TypeReference)) continue
      out.allocationInLoops.push({
        file: relPath, line, allocKind: candidate.alias,
        containingSymbol: findContainingSymbol(node),
      })
    }
  }

  return out
}

function findContainingSymbol(node: Node): string {
  let current: Node | undefined = node.getParent()
  while (current) {
    if (Node.isFunctionDeclaration(current)) return current.getName() ?? ''
    if (Node.isMethodDeclaration(current)) {
      const cls = current.getFirstAncestorByKind(SyntaxKind.ClassDeclaration)
      const className = cls?.getName() ?? ''
      const methodName = current.getName()
      return className ? `${className}.${methodName}` : methodName
    }
    if (Node.isVariableDeclaration(current)) {
      const init = current.getInitializer()
      if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
        return current.getName()
      }
    }
    current = current.getParent()
  }
  return ''
}

export interface CodeQualityPatternsAggregated {
  regexLiterals: RegexLiteralFact[]
  tryCatchSwallows: TryCatchSwallowFact[]
  awaitInLoops: AwaitInLoopFact[]
  allocationInLoops: AllocationInLoopFact[]
}

export async function analyzeCodeQualityPatterns(
  rootDir: string,
  files: string[],
  project: Project,
): Promise<CodeQualityPatternsAggregated> {
  const fileSet = new Set(files)
  const out: CodeQualityPatternsAggregated = {
    regexLiterals: [], tryCatchSwallows: [], awaitInLoops: [],
    allocationInLoops: [],
  }
  for (const sf of project.getSourceFiles()) {
    const rel = relativize(sf.getFilePath(), rootDir)
    if (!rel || !fileSet.has(rel)) continue
    const bundle = extractCodeQualityPatternsFileBundle(sf, rel)
    out.regexLiterals.push(...bundle.regexLiterals)
    out.tryCatchSwallows.push(...bundle.tryCatchSwallows)
    out.awaitInLoops.push(...bundle.awaitInLoops)
    out.allocationInLoops.push(...bundle.allocationInLoops)
  }
  const sortFn = (a: { file: string; line: number }, b: { file: string; line: number }) =>
    a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.line - b.line
  out.regexLiterals.sort(sortFn)
  out.tryCatchSwallows.sort(sortFn)
  out.awaitInLoops.sort(sortFn)
  out.allocationInLoops.sort(sortFn)
  return out
}

function relativize(absPath: string, rootDir: string): string | null {
  const normalized = absPath.replace(/\\/g, '/')
  const rootNormalized = rootDir.replace(/\\/g, '/')
  if (!normalized.startsWith(rootNormalized)) return null
  return normalized.slice(rootNormalized.length + 1)
}
