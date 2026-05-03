/**
 * Regex literals — capture les `RegExpLiteral` + `new RegExp(literal)`.
 *
 * Avec un drapeau `hasNestedQuantifier` heuristique signalant les
 * patterns du type `(a+)+`, `(a*)*` — vecteurs de catastrophic
 * backtracking (ReDoS).
 *
 * Bug historique corrigé : l'ancienne heuristique `\([^)]*[+*]\)[+*?]`
 * matchait `(?:foo*)?` (groupe optionnel) — pattern bénin, pas
 * catastrophic. Un groupe optionnel ne *répète* pas son contenu : il
 * choisit "présent ou absent". Seuls `(...)+` et `(...)*` sur un groupe
 * contenant `+`/`*` sont vraiment catastrophic. Donc on ne flague que
 * `[+*]` en suffixe (drop le `?`).
 */

import { type SourceFile, Node, SyntaxKind } from 'ts-morph'
import type { IsExempt } from './_helpers.js'

export interface RegexLiteralFact {
  file: string
  line: number
  source: string
  flags: string
  /** True ssi le source contient un nested quantifier (heuristique simple). */
  hasNestedQuantifier: boolean
}

// Pattern catastrophic backtracking : un groupe contenant `+` ou `*`
// SUIVI d'un autre `+` ou `*` (répétition de répétition). On exclut `?`
// trailing : `(a+)?` est bénin (optionnel, pas répété).
const NESTED_QUANTIFIER_RE = /\([^)]*[+*]\)[+*]/

export function extractRegexLiterals(
  sf: SourceFile,
  relPath: string,
  isExempt: IsExempt,
): RegexLiteralFact[] {
  const out: RegexLiteralFact[] = []

  for (const node of sf.getDescendantsOfKind(SyntaxKind.RegularExpressionLiteral)) {
    const line = node.getStartLineNumber()
    if (isExempt(line, 'regex-ok')) continue
    const text = node.getText()
    const m = text.match(/^\/(.*)\/([a-z]*)$/)
    if (!m) continue
    out.push({
      file: relPath,
      line,
      source: m[1],
      flags: m[2],
      hasNestedQuantifier: NESTED_QUANTIFIER_RE.test(m[1]),
    })
  }

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
    out.push({
      file: relPath,
      line,
      source,
      flags,
      hasNestedQuantifier: NESTED_QUANTIFIER_RE.test(source),
    })
  }

  return out
}
