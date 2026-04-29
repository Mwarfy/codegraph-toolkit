/**
 * OAuth Scope Literals Extractor
 *
 * Détecte les strings hardcodées matchant les patterns d'URL de scopes
 * OAuth standards (Google APIs, OpenID, etc.). Cas d'usage : Sentinel
 * ADR-014 impose `SCOPES.X` (registry typé) plutôt que `'https://www.googleapis.com/auth/...'`
 * inline. Le détecteur émet un fact par site, et une rule Datalog filtre
 * sur les fichiers exemptés (le registry lui-même).
 *
 * Approche : regex simple sur le contenu des fichiers TS. Pas d'AST —
 * la logique reproduit le test invariant TS existant à la lettre, mais
 * en l'exposant comme fact réutilisable.
 *
 * Pattern matché :
 *   - `'https://www.googleapis.com/auth/...'`
 *   - `"https://www.googleapis.com/auth/..."`
 *   - `'openid'` quand utilisé comme scope (cf. registry Sentinel SCOPES.OPENID)
 *
 * Pour rester général, on capture seulement les URLs Google Auth (pattern le
 * plus stable). Les autres scopes (email, openid raw) restent des strings
 * "normales" indistinguables sans context — out-of-scope pour ce détecteur.
 */

import * as path from 'node:path'
import type { Project } from 'ts-morph'

export interface OauthScopeLiteral {
  /** Chemin relatif au rootDir. */
  file: string
  line: number
  /** La scope URL trouvée (sans les quotes). */
  scope: string
}

export interface OauthScopeLiteralsOptions {
  /** Override du pattern regex. Default : URLs Google Auth. */
  scopePattern?: RegExp
}

const DEFAULT_SCOPE_RE = /['"](https:\/\/www\.googleapis\.com\/auth\/[^'"]+)['"]/g

export async function analyzeOauthScopeLiterals(
  rootDir: string,
  files: string[],
  project: Project,
  options: OauthScopeLiteralsOptions = {},
): Promise<OauthScopeLiteral[]> {
  const re = options.scopePattern ?? DEFAULT_SCOPE_RE
  const fileSet = new Set(files)
  const out: OauthScopeLiteral[] = []

  for (const sf of project.getSourceFiles()) {
    const relPath = relativize(sf.getFilePath(), rootDir)
    if (!relPath || !fileSet.has(relPath)) continue

    const content = sf.getFullText()
    if (!content.includes('googleapis.com/auth/')) continue              // fast skip

    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      const scope = m[1]
      const offset = m.index
      // Compute line from offset
      const before = content.slice(0, offset)
      const line = before.split('\n').length
      out.push({ file: relPath, line, scope })
    }
  }

  out.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    return a.line - b.line
  })
  return out
}

function relativize(absPath: string, rootDir: string): string | null {
  const rel = path.relative(rootDir, absPath)
  if (rel.startsWith('..')) return null
  return rel.replace(/\\/g, '/')
}
