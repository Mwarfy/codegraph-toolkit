/**
 * Dead code patterns — détecteur déterministe AST (Phase 4 Tier 3).
 *
 * Deux patterns proches conceptuellement (du code redundant/inatteignable) :
 *
 * 1. **identical-subexpressions** : les deux côtés d'un BinaryExpression
 *    (logical / equality / comparison) sont textuellement identiques.
 *    Ex : `if (a > 0 && a > 0)`, `Math.min(x, x)`, `x === x`.
 *    Inspirations : Sonar S1764, SpotBugs SA_LOCAL_SELF_COMPARISON.
 *
 * 2. **return-then-else** : `if (cond) { return X } else { Y }` où la
 *    branche else est inatteignable APRÈS le if (le return court-circuite).
 *    Le `else` est syntaxiquement valide mais sémantiquement redondant —
 *    plat = plus lisible. Inspiration : Sonar S1126.
 *
 * Les deux patterns sont AST-déterministe + contextuel (pas de
 * control-flow complet). Convention exempt : `// dead-code-ok: <reason>`
 * sur ligne précédente.
 *
 * Skip les fichiers de test (pattern souvent intentionnel en setup/mock).
 */

import { type Project, type SourceFile, Node, SyntaxKind } from 'ts-morph'
import { makeIsExemptForMarker } from './_shared/ast-helpers.js'

export type DeadCodeKind =
  | 'identical-subexpressions'
  | 'return-then-else'
  | 'switch-fallthrough'
  | 'switch-no-default'
  | 'switch-empty'
  | 'controlling-expression-constant'

export interface DeadCodeFinding {
  kind: DeadCodeKind
  file: string
  line: number
  /** Court (≤ 120 chars), actionnable. */
  message: string
  /** Détail spécifique au kind. */
  details?: Record<string, string | number | boolean>
}

export interface DeadCodeFileBundle {
  findings: DeadCodeFinding[]
}

const TEST_FILE_RE = /(\.test\.tsx?|\.spec\.tsx?|(^|\/)tests?\/|(^|\/)fixtures?\/)/

// Operators où l'identité des côtés est SUSPECTE.
// `&& || == === != !== > >= < <=` — toujours bug-prone si A == A.
// `+ - * / %` peuvent être légitimes (`x + x`, `x - x` pour debug).
const SUSPECT_OPS = new Set<string>([
  '&&', '||', '==', '===', '!=', '!==',
  '>', '>=', '<', '<=',
])

type DeadCodeIsExempt = (line: number) => boolean

function detectIdenticalSubexpressions(
  sf: SourceFile,
  relPath: string,
  isExempt: DeadCodeIsExempt,
  findings: DeadCodeFinding[],
): void {
  for (const expr of sf.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    const op = expr.getOperatorToken().getText()
    if (!SUSPECT_OPS.has(op)) continue
    const left = expr.getLeft().getText().trim()
    const right = expr.getRight().getText().trim()
    if (left !== right) continue
    // Skip constantes litterales identiques courtes (ex `0 === 0`).
    if (/^[\d"'`]/.test(left) && left.length < 4) continue
    const line = expr.getStartLineNumber()
    if (isExempt(line)) continue
    findings.push({
      kind: 'identical-subexpressions',
      file: relPath,
      line,
      message: `expression ${op} avec les 2 cotes identiques (${truncate(left, 30)}) — bug ou redondance`,
      details: { operator: op, expression: truncate(left, 60) },
    })
  }
}

function detectSwitchEmptyOrNoDefault(
  sf: SourceFile,
  relPath: string,
  isExempt: DeadCodeIsExempt,
  findings: DeadCodeFinding[],
): void {
  for (const sw of sf.getDescendantsOfKind(SyntaxKind.SwitchStatement)) {
    const clauses = sw.getCaseBlock().getClauses()
    const line = sw.getStartLineNumber()
    if (isExempt(line)) continue
    if (clauses.length === 0) {
      findings.push({
        kind: 'switch-empty',
        file: relPath, line,
        message: `switch vide (0 case) — refactor inacheve ?`,
      })
      continue
    }
    if (!clauses.some((c) => Node.isDefaultClause(c))) {
      findings.push({
        kind: 'switch-no-default',
        file: relPath, line,
        message: `switch sans clause default — comportement silencieux si valeur inattendue`,
      })
    }
  }
}

function detectControllingConstantExpressions(
  sf: SourceFile,
  relPath: string,
  isExempt: DeadCodeIsExempt,
  findings: DeadCodeFinding[],
): void {
  const isLiteralBool = (n: Node): boolean => Node.isTrueLiteral(n) || Node.isFalseLiteral(n)

  const check = (cond: Node | undefined, line: number): void => {
    if (!cond || isExempt(line)) return
    if (isLiteralBool(cond)) {
      findings.push({
        kind: 'controlling-expression-constant',
        file: relPath, line,
        message: `condition constante (${cond.getText()}) — branche dead ou code mort`,
      })
      return
    }
    if (!Node.isBinaryExpression(cond)) return
    const op = cond.getOperatorToken().getText()
    if (op !== '&&' && op !== '||') return
    if (!isLiteralBool(cond.getLeft()) && !isLiteralBool(cond.getRight())) return
    findings.push({
      kind: 'controlling-expression-constant',
      file: relPath, line,
      message: `expression ${op} avec un cote constant — simplifier`,
      details: { operator: op },
    })
  }

  for (const ifStmt of sf.getDescendantsOfKind(SyntaxKind.IfStatement)) {
    check(ifStmt.getExpression(), ifStmt.getStartLineNumber())
  }
  for (const cond of sf.getDescendantsOfKind(SyntaxKind.ConditionalExpression)) {
    check(cond.getCondition(), cond.getStartLineNumber())
  }
}

function isExitStatement(stmt: Node): boolean {
  return Node.isBreakStatement(stmt)
    || Node.isReturnStatement(stmt)
    || Node.isThrowStatement(stmt)
    || Node.isContinueStatement(stmt)
}

function clauseLastStmtExits(stmts: import('ts-morph').Statement[]): boolean {
  if (stmts.length === 0) return true  // groupage explicite OK
  const last = stmts[stmts.length - 1]
  if (isExitStatement(last)) return true
  if (Node.isBlock(last)) {
    const blockStmts = last.getStatements()
    const blockLast = blockStmts[blockStmts.length - 1]
    return blockLast ? isExitStatement(blockLast) : false
  }
  return false
}

function detectSwitchFallthroughs(
  sf: SourceFile,
  relPath: string,
  isExempt: DeadCodeIsExempt,
  lines: string[],
  findings: DeadCodeFinding[],
): void {
  for (const sw of sf.getDescendantsOfKind(SyntaxKind.SwitchStatement)) {
    const clauses = sw.getCaseBlock().getClauses()
    for (let i = 0; i < clauses.length - 1; i++) {
      const clause = clauses[i]
      const stmts = clause.getStatements()
      if (clauseLastStmtExits(stmts)) continue

      const line = clause.getStartLineNumber()
      if (isExempt(line)) continue

      // Convention C/Java : `// fallthrough` sur la ligne juste apres
      // le dernier statement = exemption explicite.
      const last = stmts[stmts.length - 1]
      const fallthroughCommentIdx = last.getEndLineNumber() + 1
      if (
        fallthroughCommentIdx - 1 < lines.length &&
        /\/\/\s*fallthrough\b/i.test(lines[fallthroughCommentIdx - 1])
      ) continue

      findings.push({
        kind: 'switch-fallthrough',
        file: relPath, line,
        message: `case sans break/return/throw — fall-through silencieux ; ajouter break ou \`// fallthrough\``,
      })
    }
  }
}

function detectReturnThenElse(
  sf: SourceFile,
  relPath: string,
  isExempt: DeadCodeIsExempt,
  findings: DeadCodeFinding[],
): void {
  // `if (cond) { return X } else { ... }` — Sonar S1126. Skip `else if` chain.
  for (const ifStmt of sf.getDescendantsOfKind(SyntaxKind.IfStatement)) {
    const elseBranch = ifStmt.getElseStatement()
    if (!elseBranch) continue
    if (Node.isIfStatement(elseBranch)) continue
    if (!thenAlwaysExits(ifStmt.getThenStatement())) continue
    const line = ifStmt.getStartLineNumber()
    if (isExempt(line)) continue
    findings.push({
      kind: 'return-then-else',
      file: relPath, line,
      message: `if/return suivi de else — flatten : retirer le else, dedent le bloc`,
    })
  }
}

export function extractDeadCodeFileBundle(
  sf: SourceFile,
  relPath: string,
): DeadCodeFileBundle {
  if (TEST_FILE_RE.test(relPath)) return { findings: [] }
  const findings: DeadCodeFinding[] = []

  const isExempt = makeIsExemptForMarker(sf, 'dead-code-ok')
  // Garde localement pour le check `// fallthrough` (convention C/Java).
  const lines = sf.getFullText().split('\n')

  detectIdenticalSubexpressions(sf, relPath, isExempt, findings)
  detectSwitchEmptyOrNoDefault(sf, relPath, isExempt, findings)
  detectControllingConstantExpressions(sf, relPath, isExempt, findings)
  detectSwitchFallthroughs(sf, relPath, isExempt, lines, findings)
  detectReturnThenElse(sf, relPath, isExempt, findings)

  return { findings }
}

/**
 * Détermine si la branche `then` d'un if SE TERMINE TOUJOURS (return /
 * throw / continue / break) — auquel cas le `else` est sémantiquement
 * inatteignable et peut être flatten.
 *
 * Cas reconnus :
 *   - `if (x) return;`           ← single statement
 *   - `if (x) throw new Error()` ← single statement
 *   - `if (x) { ...; return; }`  ← block dont le DERNIER statement exit
 *
 * Pour rester déterministe et conservatif : on ne tient compte que du
 * dernier statement du block (pas de control-flow analysis profonde).
 */
function thenAlwaysExits(then: Node): boolean {
  if (Node.isReturnStatement(then)) return true
  if (Node.isThrowStatement(then)) return true
  if (Node.isBreakStatement(then)) return true
  if (Node.isContinueStatement(then)) return true
  if (Node.isBlock(then)) {
    const stmts = then.getStatements()
    if (stmts.length === 0) return false
    const last = stmts[stmts.length - 1]
    return thenAlwaysExits(last)
  }
  return false
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

export async function analyzeDeadCode(
  rootDir: string,
  files: string[],
  project: Project,
): Promise<DeadCodeFinding[]> {
  const fileSet = new Set(files)
  const all: DeadCodeFinding[] = []

  for (const sf of project.getSourceFiles()) {
    const rel = relativize(sf.getFilePath(), rootDir)
    if (!rel || !fileSet.has(rel)) continue
    const bundle = extractDeadCodeFileBundle(sf, rel)
    all.push(...bundle.findings)
  }

  all.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    if (a.line !== b.line) return a.line - b.line
    return a.kind < b.kind ? -1 : 1
  })
  return all
}

function relativize(absPath: string, rootDir: string): string | null {
  const normalized = absPath.replace(/\\/g, '/')
  const rootNormalized = rootDir.replace(/\\/g, '/')
  if (!normalized.startsWith(rootNormalized)) return null
  return normalized.slice(rootNormalized.length + 1)
}
