/**
 * Function Complexity — McCabe + Cognitive (Top-5 graph theory uplift).
 *
 * Calcule pour chaque fonction :
 *   - cyclomatic (McCabe 1976) : 1 + branches lineaires
 *   - cognitive  (SonarQube)   : branches + nesting (penalise nesting expo)
 *
 * Difference :
 *   10 if seq           → cyclomatic=10, cognitive=10
 *   3 if dans for/while → cyclomatic=4,  cognitive=12 (1+1+ 1+2 + 1+3 + 1)
 *
 * Cognitive matche mieux la difficulte humaine de lecture/maintenance.
 * Empiriquement plus correle aux bugs (Campbell 2018).
 *
 * Pattern exempt : `// complexity-ok: <reason>` ligne precedente.
 */

import { type Project, type SourceFile, Node, SyntaxKind } from 'ts-morph'
import { makeIsExemptForMarker } from './_shared/ast-helpers.js'

export interface FunctionComplexity {
  file: string
  name: string
  line: number
  cyclomatic: number
  cognitive: number
  containingClass: string  // '' si pas une method
}

const TEST_FILE_RE = /(\.test\.tsx?|\.spec\.tsx?|(^|\/)tests?\/|(^|\/)fixtures?\/)/

// Increments cyclomatic
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

// Nesting-incrementing kinds for cognitive
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
  name: string
  body: Node
  line: number
  containingClass: string
}

function* iterateFnLikesWithBody(sf: SourceFile): Generator<FnLikeWithBody> {
  for (const fn of sf.getFunctions()) {
    const body = fn.getBody()
    if (!body) continue
    yield {
      name: fn.getName() ?? '(anonymous)',
      body,
      line: fn.getStartLineNumber(),
      containingClass: '',
    }
  }
  for (const cls of sf.getClasses()) {
    const className = cls.getName() ?? '(anonymous)'
    for (const m of cls.getMethods()) {
      const body = m.getBody()
      if (!body) continue
      yield {
        name: m.getName(),
        body,
        line: m.getStartLineNumber(),
        containingClass: className,
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
      name: v.getName(),
      body,
      line: v.getStartLineNumber(),
      containingClass: '',
    }
  }
}

export function extractFunctionComplexityFileBundle(
  sf: SourceFile,
  relPath: string,
): FunctionComplexity[] {
  if (TEST_FILE_RE.test(relPath)) return []
  const isExempt = makeIsExemptForMarker(sf, 'complexity-ok')
  const out: FunctionComplexity[] = []
  for (const fn of iterateFnLikesWithBody(sf)) {
    if (isExempt(fn.line)) continue
    out.push({
      file: relPath,
      name: fn.name,
      line: fn.line,
      cyclomatic: computeCyclomatic(fn.body),
      cognitive: computeCognitive(fn.body),
      containingClass: fn.containingClass,
    })
  }
  return out
}

/**
 * McCabe : 1 + nb branches independantes. Compte les branchements
 * structurels + boolean operators (&&, ||) qui creent des chemins.
 */
function computeCyclomatic(node: Node): number {
  let count = 1
  node.forEachDescendant((child) => {
    const kind = child.getKind()
    if (CYCLO_KINDS.has(kind)) count++
    // else if = IfStatement avec parent IfStatement.elseStatement → comptés via IfStatement standard
    // && / || dans une condition → +1 chacun (Halstead-aware)
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

/**
 * Cognitive (SonarQube simplified) :
 *   - +1 per nesting kind reached
 *   - +nestingLevel additional per nested branch
 *   - boolean operators in same expression : +1 first, 0 for sequels (skip ici simplifié)
 */
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

export async function analyzeFunctionComplexity(
  rootDir: string,
  files: string[],
  project: Project,
): Promise<FunctionComplexity[]> {
  const fileSet = new Set(files)
  const out: FunctionComplexity[] = []
  for (const sf of project.getSourceFiles()) {
    const rel = relativize(sf.getFilePath(), rootDir)
    if (!rel || !fileSet.has(rel)) continue
    out.push(...extractFunctionComplexityFileBundle(sf, rel))
  }
  out.sort((a, b) =>
    a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.line - b.line,
  )
  return out
}

function relativize(absPath: string, rootDir: string): string | null {
  const normalized = absPath.replace(/\\/g, '/')
  const rootNormalized = rootDir.replace(/\\/g, '/')
  if (!normalized.startsWith(rootNormalized)) return null
  return normalized.slice(rootNormalized.length + 1)
}
