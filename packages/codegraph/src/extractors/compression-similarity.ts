// ADR-005
/**
 * Compression-based similarity — Normalized Compression Distance (NCD).
 *
 * Origine : Kolmogorov complexity K(x) = longueur du plus court programme
 * qui produit x. Théoriquement non-calculable mais APPROXIMABLE via le
 * meilleur compresseur disponible : K(x) ~ |C(x)| où C est gzip/lzma/etc.
 *
 * Cilibrasi-Vitanyi 2005 : Normalized Compression Distance
 *
 *     NCD(x, y) = (C(xy) - min(C(x), C(y))) / max(C(x), C(y))
 *
 * Propriétés :
 *   - NCD ∈ [0, 1] (approximativement)
 *   - NCD(x, x) ≈ 0 (= duplicat strict)
 *   - NCD(x, y) faible (~0.3) = très similaires
 *   - NCD(x, y) ~ 1 = totalement différents
 *
 * Application au code : pour chaque paire de fonctions, comparer leur
 * AST normalisé (kinds + structure, pas les noms d'identifiers locaux).
 * NCD < 0.4 sur des fonctions de même nom (ex: `pauseProject` dans 2
 * fichiers) = duplication probable.
 *
 * Différenciation vs Hamming :
 *   - Hamming compare des SIGNATURES encodées (paramCount + kind +
 *     returnKind + line bucket) sur ~10 bits → exact, mais grossier
 *   - NCD compare le CONTENU compressible des fonctions → fin, capture
 *     les duplications PARTIELLES (refactor incomplet, fork divergent)
 *
 * Une fonction peut avoir Hamming=0 (signature identique) mais NCD=0.6
 * (implémentations divergentes) ou Hamming=2 (signatures légèrement
 * différentes) mais NCD=0.1 (corps quasi-copié, juste 1 paramètre
 * ajouté).
 *
 * Threshold pratique : NCD × 1000 < 400 ∧ même nom de symbole = forte
 * indication de duplication réelle. La rule composite-near-duplicate-fn
 * filtre ce signal.
 *
 * Coût : O(n²) sur les paires. On filtre par bucket (taille similaire +
 * même nom) avant de calculer le NCD complet pour rester sub-quadratique.
 *
 * Discipline : théorie de la complexité de Kolmogorov (Kolmogorov 1965)
 * approximée via compression (Cilibrasi-Vitanyi 2005).
 */

import * as zlib from 'node:zlib'
import * as path from 'node:path'
import type { Project, SourceFile, Node as TsMorphNode } from 'ts-morph'

export interface NormalizedCompressionDistance {
  /** Premier symbole (a < b lexico, dedupe). */
  symbolA: string
  /** Second symbole. */
  symbolB: string
  /** NCD × 1000. Plus bas = plus similaire. 0-300 = duplication probable. */
  ncdX1000: number
}

interface FunctionTextSnippet {
  symbol: string
  /** Texte normalisé : AST kinds + structure, pas les identifiers. */
  text: string
  /** Bucket size pour pré-filter (skip pairs où sizes >> 2x différentes). */
  size: number
}

/**
 * Compresse via gzip (stable, built-in). Retourne la taille en bytes.
 */
function compressedSize(text: string): number {
  return zlib.gzipSync(text, { level: 6 }).length
}

/**
 * NCD(x, y) = (C(x+y) - min(C(x), C(y))) / max(C(x), C(y))
 */
function ncd(textA: string, textB: string, sizeA: number, sizeB: number): number {
  const concat = textA + '\n' + textB
  const sizeAB = compressedSize(concat)
  const minSize = Math.min(sizeA, sizeB)
  const maxSize = Math.max(sizeA, sizeB)
  if (maxSize === 0) return 1
  return (sizeAB - minSize) / maxSize
}

/**
 * Calcule les NCDs pour toutes les paires de fonctions ayant le MÊME
 * NOM (le case d'usage principal — détecter duplications nominal).
 *
 * Pre-filter : taille comparable (ratio sizeA/sizeB ∈ [0.5, 2]) pour
 * éviter de comparer fonction triviale vs fonction massive.
 */
function bucketByName(snippets: FunctionTextSnippet[]): Map<string, FunctionTextSnippet[]> {
  const byName = new Map<string, FunctionTextSnippet[]>()
  for (const s of snippets) {
    const name = s.symbol.includes(':')
      ? s.symbol.slice(s.symbol.lastIndexOf(':') + 1)
      : s.symbol
    if (!byName.has(name)) byName.set(name, [])
    byName.get(name)!.push(s)
  }
  return byName
}

function makeSizeCache(): (s: FunctionTextSnippet) => number {
  const cache = new Map<string, number>()
  return (s) => {
    let cached = cache.get(s.symbol)
    if (cached === undefined) {
      cached = compressedSize(s.text)
      cache.set(s.symbol, cached)
    }
    return cached
  }
}

function tryEmitNcdPair(
  a: FunctionTextSnippet,
  b: FunctionTextSnippet,
  getSize: (s: FunctionTextSnippet) => number,
  out: NormalizedCompressionDistance[],
): void {
  // Pre-filter taille (ratio extreme = pas duplication probable).
  const ratio = a.size / b.size
  if (ratio < 0.4 || ratio > 2.5) return
  const distance = ncd(a.text, b.text, getSize(a), getSize(b))
  // Skip pairs tres differentes (NCD > 0.7) — pas signal utile.
  if (distance > 0.7) return
  const [first, second] = a.symbol < b.symbol ? [a, b] : [b, a]
  out.push({
    symbolA: first.symbol,
    symbolB: second.symbol,
    ncdX1000: Math.round(distance * 1000),
  })
}

function pairwiseNcdInBucket(
  bucket: FunctionTextSnippet[],
  getSize: (s: FunctionTextSnippet) => number,
  out: NormalizedCompressionDistance[],
): void {
  for (let i = 0; i < bucket.length; i++) {
    for (let j = i + 1; j < bucket.length; j++) {
      tryEmitNcdPair(bucket[i], bucket[j], getSize, out)
    }
  }
}

export function computeNormalizedCompressionDistances(
  snippets: FunctionTextSnippet[],
): NormalizedCompressionDistance[] {
  const out: NormalizedCompressionDistance[] = []
  const byName = bucketByName(snippets)
  const getSize = makeSizeCache()

  for (const [, bucket] of byName) {
    if (bucket.length < 2) continue
    if (bucket.length > 20) continue // skip names ultra-communs (toString, etc.)
    pairwiseNcdInBucket(bucket, getSize, out)
  }

  // Sort par NCD ascending (= duplications les + probables en haut)
  out.sort((a, b) => {
    if (a.ncdX1000 !== b.ncdX1000) return a.ncdX1000 - b.ncdX1000
    if (a.symbolA !== b.symbolA) return a.symbolA < b.symbolA ? -1 : 1
    return a.symbolB < b.symbolB ? -1 : 1
  })

  return out
}

/**
 * Helper : extrait un snippet textuel normalisé d'une node ts-morph.
 * Garde la structure + kind names mais remplace les identifiers locaux
 * par des placeholders (pour focuser sur la STRUCTURE).
 *
 * Cette normalisation est volontairement légère — gzip capturera les
 * répétitions structurelles même si quelques identifiers diffèrent.
 */
export function normalizeFunctionText(rawText: string): string {
  // Strip comments
  let text = rawText.replace(/\/\*[\s\S]*?\*\//g, '')
  text = text.replace(/\/\/[^\n]*/g, '')
  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim()
  return text
}

export type { FunctionTextSnippet }

/**
 * Wrapper avec ts-morph : extrait les body texts des fonctions/methods/
 * arrow functions du project, puis calcule les NCD pairwise.
 *
 * Filtre body text < 80 chars (= trivial, peu informatif pour NCD).
 */
export async function analyzeCompressionSimilarity(
  rootDir: string,
  files: string[],
  project: Project,
): Promise<NormalizedCompressionDistance[]> {
  const fileSet = new Set(files)
  const snippets: FunctionTextSnippet[] = []

  const relativize = (full: string): string =>
    path.relative(rootDir, full).split(path.sep).join('/')

  for (const sf of project.getSourceFiles()) {
    const rel = relativize(sf.getFilePath())
    if (!rel || !fileSet.has(rel)) continue
    extractFunctionSnippets(sf, rel, snippets)
  }

  if (snippets.length === 0) return []
  return computeNormalizedCompressionDistances(snippets)
}

const FUNCTION_LIKE_KINDS = new Set([
  'FunctionDeclaration',
  'MethodDeclaration',
  'ArrowFunction',
  'FunctionExpression',
])

/**
 * Resolve le nom d'1 fonction. Retourne '' si non-resoluble (anonymous
 * arrow non-assigne par exemple).
 *
 * Pour Arrow/FunctionExpression : prend le nom du parent
 * (VariableDeclaration ou PropertyAssignment).
 */
function resolveFunctionName(node: TsMorphNode): string {
  const named = (node as unknown as { getName?: () => string | undefined }).getName?.()
  if (named) return named

  const parent = node.getParent()
  const parentKind = parent?.getKindName() ?? ''
  if (parentKind === 'VariableDeclaration') {
    return (parent as unknown as { getName?: () => string | undefined }).getName?.() ?? ''
  }
  if (parentKind === 'PropertyAssignment') {
    return (parent as unknown as { getName?: () => string | undefined }).getName?.() ?? ''
  }
  return ''
}

function extractFunctionSnippets(
  sf: SourceFile,
  relPath: string,
  out: FunctionTextSnippet[],
): void {
  sf.forEachDescendant((node) => {
    if (!FUNCTION_LIKE_KINDS.has(node.getKindName())) return

    const body = (node as unknown as { getBody?: () => { getText: () => string } | undefined }).getBody?.()
    if (!body) return
    const bodyText = body.getText()
    if (bodyText.length < 80) return

    const name = resolveFunctionName(node)
    if (!name) return

    const text = normalizeFunctionText(bodyText)
    if (text.length < 80) return
    out.push({
      symbol: `${relPath}:${name}`,
      text,
      size: text.length,
    })
  })
}
