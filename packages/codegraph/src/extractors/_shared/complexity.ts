/**
 * Complexity helpers — McCabe cyclomatic + Sonar-style cognitive.
 *
 * Module shared : `function-complexity.ts` (analyzer per-fn) et
 * `datalog-detectors/ast-facts-visitor.ts` (single AST pass batch)
 * partagent ces algos.
 *
 * Pourquoi un module commun : si les seuils ou implémentations divergent
 * entre les 2 chemins (full pipeline vs Datalog one-pass), un même
 * fichier peut donner des cyclomatic différents → faux NEW dans le
 * shadow comparator (ADR-026 phase A.1) + violations COMPOSITE-CYCLOMATIC-BOMB
 * incohérentes entre runs. La cohérence est CRUCIAL pour le ratchet.
 *
 * Garde-fou : changer ces algos demande de re-baseliner (codegraph
 * datalog-check --update-baseline) — sinon les violations existantes
 * se reclassent NEW vs RESOLVED.
 */

import { type Node, SyntaxKind } from 'ts-morph'

/** Kinds qui incrémentent McCabe cyclomatic complexity. */
export const CYCLO_KINDS: ReadonlySet<number> = new Set<number>([
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

/** Kinds qui incrémentent ET nestent (cognitive). */
export const COG_NEST_KINDS: ReadonlySet<number> = new Set<number>([
  SyntaxKind.IfStatement,
  SyntaxKind.ForStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.CatchClause,
  SyntaxKind.ConditionalExpression,
])

/**
 * McCabe : 1 + nb branches independantes. Compte les branchements
 * structurels + boolean operators (&&, ||, ??) qui creent des chemins.
 */
export function computeCyclomatic(node: Node): number {
  let count = 1
  node.forEachDescendant((child) => {
    const kind = child.getKind()
    if (CYCLO_KINDS.has(kind)) count++
    // else if = IfStatement avec parent IfStatement.elseStatement → comptés via IfStatement standard
    // && / || / ?? dans une condition → +1 chacun (Halstead-aware)
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
export function computeCognitive(node: Node): number {
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
