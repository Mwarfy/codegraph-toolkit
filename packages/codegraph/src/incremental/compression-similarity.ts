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
const FN_LIKE_KINDS = new Set([
  'FunctionDeclaration',
  'MethodDeclaration',
  'ArrowFunction',
  'FunctionExpression',
])

function extractFunctionSnippetsLocal(
  sf: SourceFile,
  relPath: string,
): FunctionTextSnippet[] {
  const out: FunctionTextSnippet[] = []
  sf.forEachDescendant((node) => {
    if (!FN_LIKE_KINDS.has(node.getKindName())) return
    const snippet = buildSnippetForFnNode(node, relPath)
    if (snippet) out.push(snippet)
  })
  return out
}

interface FnNodeAccessors {
  getBody?: () => { getText: () => string } | undefined
  getName?: () => string | undefined
}

function buildSnippetForFnNode(
  node: import('ts-morph').Node,
  relPath: string,
): FunctionTextSnippet | null {
  const bodyText = readBodyText(node)
  if (!bodyText || bodyText.length < 80) return null

  const name = resolveFnName(node)
  if (!name) return null

  const text = normalizeFunctionText(bodyText)
  if (text.length < 80) return null
  return { symbol: `${relPath}:${name}`, text, size: text.length }
}

function readBodyText(node: import('ts-morph').Node): string | null {
  const body = (node as unknown as FnNodeAccessors).getBody?.()
  return body ? body.getText() : null
}

/** Direct getName() OR remonte au parent (VariableDeclaration/PropertyAssignment). */
function resolveFnName(node: import('ts-morph').Node): string {
  const direct = (node as unknown as FnNodeAccessors).getName?.()
  if (direct) return direct
  const parent = node.getParent()
  if (!parent) return ''
  const parentKind = parent.getKindName()
  if (parentKind !== 'VariableDeclaration' && parentKind !== 'PropertyAssignment') return ''
  return (parent as unknown as FnNodeAccessors).getName?.() ?? ''
}
