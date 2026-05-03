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

export function extractDeadCodeFileBundle(
  sf: SourceFile,
  relPath: string,
): DeadCodeFileBundle {
  if (TEST_FILE_RE.test(relPath)) return { findings: [] }
  const findings: DeadCodeFinding[] = []

  const isExempt = makeIsExemptForMarker(sf, 'dead-code-ok')
  // Aussi gardé localement pour le check `// fallthrough` ci-dessous
  // (convention C/Java spécifique au switch-fallthrough pattern).
  const lines = sf.getFullText().split('\n')

  // ─── Pattern 1 : identical-subexpressions ──────────────────────────
  for (const expr of sf.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    const op = expr.getOperatorToken().getText()
    if (!SUSPECT_OPS.has(op)) continue
    const left = expr.getLeft().getText().trim()
    const right = expr.getRight().getText().trim()
    if (left !== right) continue
    // Skip si c'est juste une constante littérale identique de chaque
    // côté (ex `0 === 0` typique de tests / typings) — peu probable
    // d'être un bug.
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

  // ─── Pattern 4 : switch-empty / switch-no-default (Tier 6, MISRA 16.6) ───
  // - switch vide (0 case) = bug-prone (probable refactor inachevé)
  // - switch sans clause `default` = oubli d'un cas, comportement
  //   silencieux. Skip si le switch est sur une discriminated union
  //   exhaustive (impossible à détecter sans typecheck — donc on
  //   préfère flagger et laisser le user grandfather si exhaustif).
  for (const sw of sf.getDescendantsOfKind(SyntaxKind.SwitchStatement)) {
    const clauses = sw.getCaseBlock().getClauses()
    const line = sw.getStartLineNumber()
    if (isExempt(line)) continue
    if (clauses.length === 0) {
      findings.push({
        kind: 'switch-empty',
        file: relPath,
        line,
        message: `switch vide (0 case) — refactor inacheve ?`,
      })
      continue
    }
    const hasDefault = clauses.some((c) => Node.isDefaultClause(c))
    if (!hasDefault) {
      findings.push({
        kind: 'switch-no-default',
        file: relPath,
        line,
        message: `switch sans clause default — comportement silencieux si valeur inattendue`,
      })
    }
  }

  // ─── Pattern 5 : controlling-expression-constant (Tier 6, MISRA 14.3) ───
  // `if (true && X)`, `if (false || X)`, `if (X || true)`, `if (true)`
  // — la valeur du test est connue statiquement. Constant folding lite.
  // Skip `while (true)` (boucle infinie volontaire), `do {} while(false)`
  // (forme idiomatique).
  const isLiteralBool = (n: Node, value: boolean): boolean => {
    if (Node.isTrueLiteral(n)) return value === true
    if (Node.isFalseLiteral(n)) return value === false
    return false
  }
  const checkControlling = (cond: Node | undefined, line: number): void => {
    if (!cond || isExempt(line)) return
    // `if (true)` ou `if (false)` direct.
    if (isLiteralBool(cond, true) || isLiteralBool(cond, false)) {
      findings.push({
        kind: 'controlling-expression-constant',
        file: relPath,
        line,
        message: `condition constante (${cond.getText()}) — branche dead ou code mort`,
      })
      return
    }
    // `cond && true/false` ou `true/false && cond` ou `||` variants.
    if (Node.isBinaryExpression(cond)) {
      const op = cond.getOperatorToken().getText()
      if (op !== '&&' && op !== '||') return
      const left = cond.getLeft()
      const right = cond.getRight()
      // `X && true` redondant ; `X && false` toujours faux ; `X || true`
      // toujours vrai ; `X || false` redondant. Tous les 4 = controlling
      // expression simplifiable.
      const litLeft = Node.isTrueLiteral(left) || Node.isFalseLiteral(left)
      const litRight = Node.isTrueLiteral(right) || Node.isFalseLiteral(right)
      if (litLeft || litRight) {
        findings.push({
          kind: 'controlling-expression-constant',
          file: relPath,
          line,
          message: `expression ${op} avec un cote constant — simplifier`,
          details: { operator: op },
        })
      }
    }
  }
  for (const ifStmt of sf.getDescendantsOfKind(SyntaxKind.IfStatement)) {
    checkControlling(ifStmt.getExpression(), ifStmt.getStartLineNumber())
  }
  for (const cond of sf.getDescendantsOfKind(SyntaxKind.ConditionalExpression)) {
    checkControlling(cond.getCondition(), cond.getStartLineNumber())
  }

  // ─── Pattern 3 : switch-fallthrough (Tier 4) ───────────────────────
  // gcc -Wimplicit-fallthrough. `case X: doStuff()` sans break / return
  // / throw / continue → tombe silencieusement dans le case suivant.
  // Bug-prone classique. Skip le DERNIER case (pas de fall-through
  // possible) et les cases vides (groupage explicite : `case A: case B:`).
  for (const sw of sf.getDescendantsOfKind(SyntaxKind.SwitchStatement)) {
    const clauses = sw.getCaseBlock().getClauses()
    for (let i = 0; i < clauses.length - 1; i++) {
      const clause = clauses[i]
      // Skip default au milieu (rare, mais le check fall-through s'applique).
      if (Node.isDefaultClause(clause) && i === clauses.length - 1) continue
      const stmts = clause.getStatements()
      if (stmts.length === 0) continue       // groupage explicite, OK
      const last = stmts[stmts.length - 1]
      if (
        Node.isBreakStatement(last) ||
        Node.isReturnStatement(last) ||
        Node.isThrowStatement(last) ||
        Node.isContinueStatement(last)
      ) continue
      // Block dont le dernier statement exit ?
      if (Node.isBlock(last)) {
        const blockStmts = last.getStatements()
        const blockLast = blockStmts[blockStmts.length - 1]
        if (
          blockLast && (
            Node.isBreakStatement(blockLast) ||
            Node.isReturnStatement(blockLast) ||
            Node.isThrowStatement(blockLast) ||
            Node.isContinueStatement(blockLast)
          )
        ) continue
      }

      const line = clause.getStartLineNumber()
      if (isExempt(line)) continue
      // Comment // fallthrough sur la ligne juste après le dernier
      // statement = exemption explicite (convention C/Java).
      const lastLine = last.getEndLineNumber()
      const fallthroughCommentIdx = lastLine + 1   // ligne 1-based, lines[] 0-based
      if (
        fallthroughCommentIdx - 1 < lines.length &&
        /\/\/\s*fallthrough\b/i.test(lines[fallthroughCommentIdx - 1])
      ) continue

      findings.push({
        kind: 'switch-fallthrough',
        file: relPath,
        line,
        message: `case sans break/return/throw — fall-through silencieux ; ajouter break ou \`// fallthrough\``,
      })
    }
  }

  // ─── Pattern 2 : return-then-else ──────────────────────────────────
  // `if (cond) { return X } else { ... }` — le else est inatteignable
  // APRÈS le if (le return du then court-circuite). Pattern Sonar S1126.
  for (const ifStmt of sf.getDescendantsOfKind(SyntaxKind.IfStatement)) {
    const elseBranch = ifStmt.getElseStatement()
    if (!elseBranch) continue
    // Skip `else if` chain — c'est un pattern lisible reconnu.
    if (Node.isIfStatement(elseBranch)) continue

    const thenBranch = ifStmt.getThenStatement()
    if (!thenAlwaysExits(thenBranch)) continue

    const line = ifStmt.getStartLineNumber()
    if (isExempt(line)) continue
    findings.push({
      kind: 'return-then-else',
      file: relPath,
      line,
      message: `if/return suivi de else — flatten : retirer le else, dedent le bloc`,
    })
  }

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
