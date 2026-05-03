// ADR-007
/**
 * Incremental compression-similarity — Salsa wrapper around the per-file
 * function snippet extraction. NCD pairwise reste hors-cache (calcul
 * cross-fichier dépendant de tous les snippets).
 *
 * Self-optim discovery : ce détecteur sortait hot warm (mean=233ms,
 * λ_lyap=1.00) après les autres optims. Pattern Salsa standard :
 * per-file snippet extraction cached on fileContent.
 *
 * Architecture (pattern ADR-005 + ADR-007) :
 *   - `compressionSnippetsOfFile(path)` : derived → snippet[] pour 1 file.
 *     Dep tracking sur `fileContent(path)` → invalidation file-scoped.
 *   - `allCompressionSimilarity(label)` : agrège tous les snippets puis
 *     appelle `computeNormalizedCompressionDistances` (cross-file calc,
 *     hors-cache).
 */

import { derived } from '@liby-tools/salsa'
import {
  computeNormalizedCompressionDistances,
  normalizeFunctionText,
  type FunctionTextSnippet,
  type NormalizedCompressionDistance,
} from '../extractors/compression-similarity.js'
import type { SourceFile } from 'ts-morph'
import { sharedDb as db } from './database.js'
import {
  fileContent,
  projectFiles,
  getIncrementalProject,
  getIncrementalRootDir,
} from './queries.js'
import * as path from 'node:path'

/** Per-file snippets — cached on fileContent. */
export const compressionSnippetsOfFile = derived<string, FunctionTextSnippet[]>(
  db,
  'compressionSnippetsOfFile',
  (filePath) => {
    fileContent.get(filePath)                                              // dep tracking
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) return []
    return extractFunctionSnippetsLocal(sf, filePath)
  },
)

/** Global aggregator — combine snippets puis NCD pairwise (cross-file calc). */
export const allCompressionSimilarity = derived<string, NormalizedCompressionDistance[]>(
  db,
  'allCompressionSimilarity',
  (label) => {
    const files = projectFiles.get(label)
    const snippets: FunctionTextSnippet[] = []
    for (const f of files) {
      snippets.push(...compressionSnippetsOfFile.get(f))
    }
    if (snippets.length === 0) return []
    return computeNormalizedCompressionDistances(snippets)
  },
)

/**
 * Copie locale de `extractFunctionSnippets` privée du extractor — logique
 * strictement identique au original (cf. compression-similarity.ts L200-247).
 * Si tu modifies l'algo upstream, mirror ici (un test d'équivalence
 * garantirait la parité — TODO).
 */
function extractFunctionSnippetsLocal(
  sf: SourceFile,
  relPath: string,
): FunctionTextSnippet[] {
  const out: FunctionTextSnippet[] = []
  sf.forEachDescendant((node) => {
    const kind = node.getKindName()
    if (
      kind !== 'FunctionDeclaration' &&
      kind !== 'MethodDeclaration' &&
      kind !== 'ArrowFunction' &&
      kind !== 'FunctionExpression'
    ) {
      return
    }
    const body = (node as unknown as { getBody?: () => { getText: () => string } | undefined }).getBody?.()
    if (!body) return
    const bodyText = body.getText()
    if (bodyText.length < 80) return

    let name = ''
    const nameNode = (node as unknown as { getName?: () => string | undefined }).getName?.()
    if (nameNode) name = nameNode
    if (!name) {
      const parent = node.getParent()
      const parentKind = parent?.getKindName() ?? ''
      if (parentKind === 'VariableDeclaration') {
        const vname = (parent as unknown as { getName?: () => string | undefined }).getName?.()
        if (vname) name = vname
      } else if (parentKind === 'PropertyAssignment') {
        const pname = (parent as unknown as { getName?: () => string | undefined }).getName?.()
        if (pname) name = pname
      }
    }
    if (!name) return

    const text = normalizeFunctionText(bodyText)
    if (text.length < 80) return
    out.push({
      symbol: `${relPath}:${name}`,
      text,
      size: text.length,
    })
  })
  return out
}
