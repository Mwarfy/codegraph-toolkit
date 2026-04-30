/**
 * Incremental oauth-scope-literals — wrap Salsa autour du regex scan.
 *
 * Plus simple qu'env-usage parce que le scan est pur string-based
 * (pas d'AST). On n'a même pas besoin d'accéder au ts-morph Project —
 * `fileContent.get(path)` suffit.
 *
 * Architecture symétrique à env-usage :
 *   - `oauthScopesOfFile(path)` : derived → OauthScopeLiteral[].
 *     Dépend de `fileContent(path)`.
 *   - `allOauthScopeLiterals(label)` : agrégat avec tri.
 */

import { derived } from '@liby-tools/salsa'
import {
  scanOauthScopesInContent,
  DEFAULT_OAUTH_SCOPE_RE,
  type OauthScopeLiteral,
} from '../extractors/oauth-scope-literals.js'
import { sharedDb as db } from './database.js'
import { fileContent, projectFiles } from './queries.js'

export const oauthScopesOfFile = derived<string, OauthScopeLiteral[]>(
  db, 'oauthScopesOfFile',
  (filePath) => {
    const content = fileContent.get(filePath)
    return scanOauthScopesInContent(content, filePath, DEFAULT_OAUTH_SCOPE_RE)
  },
)

export const allOauthScopeLiterals = derived<string, OauthScopeLiteral[]>(
  db, 'allOauthScopeLiterals',
  (label) => {
    const files = projectFiles.get(label)
    const out: OauthScopeLiteral[] = []
    for (const f of files) {
      out.push(...oauthScopesOfFile.get(f))
    }
    out.sort((a, b) => {
      if (a.file !== b.file) return a.file < b.file ? -1 : 1
      return a.line - b.line
    })
    return out
  },
)
