/**
 * Try/catch swallow — détecte les catch blocks qui mangent silencieusement
 * les erreurs.
 *
 * 3 kinds :
 *   - `empty`       : `catch {}` sans rien (et sans commentaire d'intention)
 *   - `log-only`    : `catch (e) { logger.error(e) }` — log mais pas rethrow
 *   - `no-rethrow`  : statements custom mais aucun `throw` dans le body
 *
 * Exemption : si le catch contient un commentaire substantiel (≥ 3 chars
 * après `//` ou `/* *\/`), on considère que l'auteur a documenté
 * l'intention → skip. Idem pour le marker `// catch-ok` au-dessus.
 */

import { type SourceFile, SyntaxKind } from 'ts-morph'
import { findContainingSymbol } from '../../_shared/ast-helpers.js'
import type { IsExempt } from './_helpers.js'

export interface TryCatchSwallowFact {
  file: string
  line: number
  /** Kind du catch : 'empty' | 'log-only' | 'no-rethrow' */
  kind: string
  containingSymbol: string
}

const LOG_CALL_RE = /(?:console|logger|log)\.[a-z]+\s*\(/i
const THROW_RE = /throw\s/

export function extractTryCatchSwallows(
  sf: SourceFile,
  relPath: string,
  isExempt: IsExempt,
): TryCatchSwallowFact[] {
  const out: TryCatchSwallowFact[] = []
  for (const tryStmt of sf.getDescendantsOfKind(SyntaxKind.TryStatement)) {
    const line = tryStmt.getStartLineNumber()
    if (isExempt(line, 'catch-ok')) continue
    const catchClause = tryStmt.getCatchClause()
    if (!catchClause) continue
    const kind = classifyCatchClause(catchClause)
    if (!kind) continue
    out.push({
      file: relPath,
      line,
      kind,
      containingSymbol: findContainingSymbol(tryStmt),
    })
  }
  return out
}

/**
 * Returns 'empty' | 'log-only' | 'no-rethrow' si le catch block swallow,
 * null si rethrow présent OU body vide commenté (intention documentée).
 */
function classifyCatchClause(
  catchClause: import('ts-morph').CatchClause,
): string | null {
  const block = catchClause.getBlock()
  const stmts = block.getStatements()

  if (stmts.length === 0) {
    return hasIntentionalEmptyComment(block.getText()) ? null : 'empty'
  }

  let allLog = true
  let hasRethrow = false
  for (const stmt of stmts) {
    const t = stmt.getText()
    if (THROW_RE.test(t)) hasRethrow = true
    if (!LOG_CALL_RE.test(t) && !THROW_RE.test(t)) allLog = false
  }
  if (hasRethrow) return null
  return allLog ? 'log-only' : 'no-rethrow'
}

// Body vide avec commentaire substantiel (≥ 3 chars) :
//   `catch { /* best-effort */ }` ou `catch { // intentional }`
//   = intention documentée → skip.
function hasIntentionalEmptyComment(blockText: string): boolean {
  const inside = blockText.slice(1, -1).trim()
  return /\/\*[\s\S]{3,}\*\//.test(inside) || /\/\/.{3,}/.test(inside)
}
