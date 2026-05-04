/**
 * Magic Numbers Detector — déterministe, AST-based.
 *
 * Capture les littéraux numériques "magiques" hardcodés dans le code :
 * timeouts, intervals, limits, retries, ports, percentages — qui devraient
 * vivre dans une config ou env var (cf. ADR-019 typed-runtime-thresholds).
 *
 * Heuristique :
 *   - Skip 0, 1, -1, 100 (constants triviaux)
 *   - Skip array indices `arr[2]` / `slice(0, 5)` / `Math.pow(x, 2)` patterns courts
 *   - Skip enum-like (number en switch case ou comparaison à un identifier connu)
 *   - Capture les literals >= 1000 (millisecondes, ms thresholds)
 *   - Capture les literals dans des appels `setInterval(fn, N)`,
 *     `setTimeout(fn, N)`, `.delay(N)`, `.retry(N)`, etc.
 *   - Capture aussi les float literals utilisés comme ratios (0.1, 0.5, 0.95)
 *
 * Sortie : liste de { file, line, value, context } pour audit / migration
 * vers env-driven thresholds.
 *
 * Pattern ADR-005 : extractMagicNumbersFileBundle(sf, relPath) per-file →
 * agrégat concat trivial.
 */

import { type Project, type SourceFile, SyntaxKind, Node } from 'ts-morph'

export interface MagicNumber {
  file: string
  line: number
  /** Valeur littérale (number ou bigint stringifiée). */
  value: string
  /** Contexte court : nom de fonction appelée ou propriété assignée. */
  context: string
  /** Catégorie heuristique. */
  category: 'timeout' | 'threshold' | 'ratio' | 'large-int' | 'other'
}

export interface MagicNumbersFileBundle {
  numbers: MagicNumber[]
}

export interface MagicNumbersOptions {
  /** Min absolute value au-dessus duquel un literal devient suspect (default: 1000). */
  minMagnitude?: number
}

const TRIVIAL_VALUES = new Set([0, 1, -1, 2, 100, 1000])

const TIMEOUT_FN_NAMES = new Set([
  'setInterval', 'setTimeout', 'setImmediate', 'delay', 'sleep', 'wait',
])

const TIMEOUT_PROPERTY_NAMES = new Set([
  'timeout', 'timeoutMs', 'delay', 'delayMs', 'interval', 'intervalMs',
  'ttl', 'ttlMs', 'retryAfter', 'retryAfterMs', 'maxAge', 'maxAgeMs',
])

const THRESHOLD_PROPERTY_NAMES = new Set([
  'maxRetries', 'limit', 'maxConcurrency', 'maxSize', 'minSize',
  'threshold', 'budget', 'capacity', 'maxTokens', 'minTokens',
])

/**
 * Bundle per-file.
 */
export function extractMagicNumbersFileBundle(
  sf: SourceFile,
  relPath: string,
  minMagnitude: number = 1000,
): MagicNumbersFileBundle {
  const numbers: MagicNumber[] = []

  // Walk numeric literals
  for (const lit of sf.getDescendantsOfKind(SyntaxKind.NumericLiteral)) {
    const text = lit.getText()
    const value = parseFloat(text.replace(/_/g, ''))
    if (!Number.isFinite(value)) continue

    // Skip trivial small ints
    if (TRIVIAL_VALUES.has(value)) continue

    const parent = lit.getParent()
    if (!parent) continue

    // Determine context + category
    const { context, category, capture } = classifyLiteral(lit, parent, value, minMagnitude)
    if (!capture) continue

    numbers.push({
      file: relPath,
      line: lit.getStartLineNumber(),
      value: text,
      context,
      category,
    })
  }

  return { numbers }
}

interface Classification {
  context: string
  category: MagicNumber['category']
  capture: boolean
}

const SKIP_CLASSIFICATION: Classification = { context: '', category: 'other', capture: false }
const COMPARISON_OPS = new Set(['>', '<', '>=', '<=', '===', '==', '!==', '!='])

function classifyLiteral(
  _lit: Node,
  parent: Node,
  value: number,
  minMagnitude: number,
): Classification {
  if (Node.isCallExpression(parent)) {
    return classifyCallArgument(parent, value, minMagnitude)
  }
  if (Node.isPropertyAssignment(parent)) {
    return classifyPropertyAssignment(parent, value, minMagnitude)
  }
  if (Node.isVariableDeclaration(parent)) {
    return classifyVarDeclaration(parent, value, minMagnitude)
  }
  if (Node.isBinaryExpression(parent)) {
    return classifyBinaryComparison(parent, value, minMagnitude)
  }
  return SKIP_CLASSIFICATION
}

/** Case 1 : argument d'un appel — setInterval(fn, 30000) etc. */
function classifyCallArgument(
  call: import('ts-morph').CallExpression,
  value: number,
  minMagnitude: number,
): Classification {
  const callName = getCallName(call.getExpression())
  if (callName && TIMEOUT_FN_NAMES.has(callName)) {
    return { context: callName, category: 'timeout', capture: true }
  }
  if (Math.abs(value) >= minMagnitude) {
    return { context: callName ?? 'call', category: 'large-int', capture: true }
  }
  return SKIP_CLASSIFICATION
}

/** Case 2 : property assignment — { timeoutMs: 30000 }. */
function classifyPropertyAssignment(
  prop: import('ts-morph').PropertyAssignment,
  value: number,
  minMagnitude: number,
): Classification {
  const propName = prop.getName()
  if (TIMEOUT_PROPERTY_NAMES.has(propName)) {
    return { context: propName, category: 'timeout', capture: true }
  }
  if (THRESHOLD_PROPERTY_NAMES.has(propName)) {
    return { context: propName, category: 'threshold', capture: true }
  }
  if (value > 0 && value < 1) {
    return { context: propName, category: 'ratio', capture: true }
  }
  if (Math.abs(value) >= minMagnitude) {
    return { context: propName, category: 'large-int', capture: true }
  }
  return SKIP_CLASSIFICATION
}

/**
 * Case 3 : variable initializer — `const TIMEOUT_MS = 30000`. La constante
 * elle-même est OK, mais on la signale pour audit sauf si SCREAMING_SNAKE
 * convention claire (déjà extracté en const).
 */
function classifyVarDeclaration(
  v: import('ts-morph').VariableDeclaration,
  value: number,
  minMagnitude: number,
): Classification {
  const name = v.getName()
  if (/^[A-Z][A-Z0-9_]*$/.test(name)) return SKIP_CLASSIFICATION
  if (Math.abs(value) >= minMagnitude) {
    return { context: name, category: 'large-int', capture: true }
  }
  return SKIP_CLASSIFICATION
}

/** Case 4 : binary expression (`x > 5000` ou `x === 200`). */
function classifyBinaryComparison(
  ba: import('ts-morph').BinaryExpression,
  value: number,
  minMagnitude: number,
): Classification {
  const op = ba.getOperatorToken().getText()
  if (!COMPARISON_OPS.has(op)) return SKIP_CLASSIFICATION
  if (Math.abs(value) >= minMagnitude) {
    return { context: `compare ${op}`, category: 'large-int', capture: true }
  }
  return SKIP_CLASSIFICATION
}

function getCallName(expr: Node): string | null {
  if (Node.isIdentifier(expr)) return expr.getText()
  if (Node.isPropertyAccessExpression(expr)) return expr.getName()
  return null
}

export async function analyzeMagicNumbers(
  rootDir: string,
  files: string[],
  project: Project,
  options: MagicNumbersOptions = {},
): Promise<MagicNumber[]> {
  const minMagnitude = options.minMagnitude ?? 1000
  const fileSet = new Set(files)
  const all: MagicNumber[] = []

  for (const sf of project.getSourceFiles()) {
    const rel = relativize(sf.getFilePath(), rootDir)
    if (!rel || !fileSet.has(rel)) continue
    // Skip tests fixtures et tests eux-mêmes (volontairement magic-heavy)
    if (rel.includes('/tests/') || rel.includes('/__tests__/') || rel.endsWith('.test.ts')) continue
    const bundle = extractMagicNumbersFileBundle(sf, rel, minMagnitude)
    all.push(...bundle.numbers)
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
