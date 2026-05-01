/**
 * Sanitizers — détecteur déterministe AST (Phase 4 Tier 10).
 *
 * Capture les call-sites de fonctions qui ASSAINISSENT un user input :
 *   - Validation : zod.parse, zod.safeParse, validateBody, joi.validate,
 *     yup.validate, ajv.validate
 *   - Escape : escape, escapeHtml, sanitizeHtml, DOMPurify.sanitize
 *   - Path normalization : path.normalize, path.resolve, path.join
 *   - Type cast safe : Number(...), parseInt(...), parseFloat(...)
 *     (skip — trop de faux-négatifs sur ce qui passerait pour validation)
 *   - SQL prepared statement (paramétré) : non-detectable AST seul
 *
 * Émet le fact `Sanitizer(file, line, callee)`. Combiné avec EntryPoint
 * + SymbolCallEdge transitif + Sink, on obtient les composites taint-aware.
 *
 * Convention exempt : non — un sanitizer qu'on veut SKIP est juste pas
 * détecté et le composite peut grandfather le site individuellement.
 */

import { type Project, type SourceFile, Node, SyntaxKind } from 'ts-morph'
import { findContainingSymbol } from './_shared/ast-helpers.js'

export interface Sanitizer {
  file: string
  line: number
  /** Nom de la fonction sanitizer appelée. */
  callee: string
  /** Le symbole englobant. */
  containingSymbol: string
}

export interface SanitizersFileBundle {
  sanitizers: Sanitizer[]
}

const TEST_FILE_RE = /(\.test\.tsx?|\.spec\.tsx?|(^|\/)tests?\/|(^|\/)fixtures?\/)/

// Sanitizer methods reconnus. Couvre les libs validation classiques + les
// helpers Sentinel/projet-specific via convention naming (validateBody,
// validateParams, etc.).
const SANITIZER_METHODS = new Set<string>([
  // Zod
  'parse', 'safeParse', 'safeParseAsync', 'parseAsync',
  // Joi / Yup / Ajv
  'validate', 'validateSync', 'validateAsync',
  // Sentinel + convention generique
  'validateBody', 'validateQuery', 'validateParams', 'validateInput',
  'validateRequest', 'validateSchema',
  // Escape
  'escape', 'escapeHtml', 'sanitize', 'sanitizeHtml', 'sanitizeUrl',
  // Path
  'normalize', 'resolve',
  // Encode / decode
  'encodeURIComponent', 'encodeURI',
])

// Patterns de noms de fonction qui SUGGERENT la sanitization meme
// si le method name n'est pas dans la liste ci-dessus. Ex:
// `validateUserInput`, `cleanString`. Match prefix uniquement.
const SANITIZER_NAME_PREFIXES = /^(validate|sanitize|clean|escape|normalize|verify|check|parse)/i

export function extractSanitizersFileBundle(
  sf: SourceFile,
  relPath: string,
): SanitizersFileBundle {
  if (TEST_FILE_RE.test(relPath)) return { sanitizers: [] }
  const sanitizers: Sanitizer[] = []

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression()
    let methodName: string | null = null
    let calleeText: string

    if (Node.isIdentifier(callee)) {
      methodName = callee.getText()
      calleeText = methodName
    } else if (Node.isPropertyAccessExpression(callee)) {
      methodName = callee.getName()
      calleeText = callee.getText()
    } else {
      continue
    }

    if (!methodName) continue

    // Match exact dans la liste OU match prefix par convention naming.
    const matches = SANITIZER_METHODS.has(methodName) ||
                    SANITIZER_NAME_PREFIXES.test(methodName)
    if (!matches) continue

    sanitizers.push({
      file: relPath,
      line: call.getStartLineNumber(),
      callee: calleeText,
      containingSymbol: findContainingSymbol(call),
    })
  }

  return { sanitizers }
}

export async function analyzeSanitizers(
  rootDir: string,
  files: string[],
  project: Project,
): Promise<Sanitizer[]> {
  const fileSet = new Set(files)
  const all: Sanitizer[] = []

  for (const sf of project.getSourceFiles()) {
    const rel = relativize(sf.getFilePath(), rootDir)
    if (!rel || !fileSet.has(rel)) continue
    const bundle = extractSanitizersFileBundle(sf, rel)
    all.push(...bundle.sanitizers)
  }

  all.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    return a.line - b.line
  })
  return all
}

function relativize(absPath: string, rootDir: string): string | null {
  const normalized = absPath.replace(/\\/g, '/')
  const rootNormalized = rootDir.replace(/\\/g, '/')
  if (!normalized.startsWith(rootNormalized)) return null
  return normalized.slice(rootNormalized.length + 1)
}
