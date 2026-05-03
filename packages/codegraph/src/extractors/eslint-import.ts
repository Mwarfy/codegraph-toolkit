// ADR-005
/**
 * ESLint Import — ingester du JSON output ESLint vers facts datalog.
 *
 * Pourquoi : ESLint a 10 ans d'engineering sur les patterns triviaux
 * (no-self-compare, no-constant-condition, no-unreachable, etc.). Plutôt
 * que de réécrire ces règles, on **ingère** le JSON output ESLint et on
 * émet des facts queryables par datalog. Ça permet ensuite des composite
 * rules cross-discipline (ex: "violation ESLint dans un truth-point
 * writer non-testé") que ESLint seul ne peut PAS exprimer.
 *
 * Pattern :
 *   1. L'utilisateur run `npx eslint . --format json > /tmp/eslint.json`
 *   2. Le toolkit lit ce JSON via cet ingester
 *   3. Émet `EslintViolation(file, line, ruleId, severity, message)`
 *   4. Datalog rules join avec les autres facts (TruthPointWriter,
 *      GrangerCausality, !TestedFile, etc.)
 *
 * Format ESLint JSON attendu (depuis ESLint 7+) :
 *   [
 *     {
 *       "filePath": "/abs/path/to/file.ts",
 *       "messages": [
 *         { "ruleId": "no-self-compare", "severity": 2, "message": "...",
 *           "line": 42, "column": 10 }
 *       ]
 *     }
 *   ]
 *
 * Le toolkit ne run PAS ESLint directement (variabilité config / plugins
 * trop élevée). L'utilisateur configure ESLint comme il veut, run, puis
 * passe le JSON path. Pattern decoupling — chacun son métier.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export interface EslintViolation {
  /** Path relatif au rootDir. */
  file: string
  line: number
  column: number
  /** ESLint rule id (ex: 'no-self-compare', 'no-unused-vars'). */
  ruleId: string
  /** 1 = warning, 2 = error. */
  severity: number
  /** Message ESLint, tronqué. */
  message: string
}

export interface EslintImportOptions {
  /** Path du JSON ESLint output. Default: <rootDir>/.codegraph/eslint.json */
  jsonPath?: string
}

export async function importEslintViolations(
  rootDir: string,
  options: EslintImportOptions = {},
): Promise<EslintViolation[]> {
  const jsonPath = options.jsonPath ?? path.join(rootDir, '.codegraph/eslint.json')

  let raw: string
  try {
    raw = await fs.readFile(jsonPath, 'utf-8')
  } catch {
    return [] // pas de eslint.json — silencieux, fact relation reste vide
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }

  if (!Array.isArray(parsed)) return []

  const out: EslintViolation[] = []
  for (const fileResult of parsed) {
    if (!fileResult || typeof fileResult !== 'object') continue
    const fr = fileResult as { filePath?: string; messages?: unknown[] }
    if (typeof fr.filePath !== 'string' || !Array.isArray(fr.messages)) continue
    // Convert absolute path to relative.
    const relFile = path.relative(rootDir, fr.filePath).replace(/\\/g, '/')
    if (relFile.startsWith('..')) continue // hors-projet

    for (const msg of fr.messages) {
      if (!msg || typeof msg !== 'object') continue
      const m = msg as {
        ruleId?: string | null
        severity?: number
        message?: string
        line?: number
        column?: number
      }
      // Skip parsing errors (ruleId === null) and missing line.
      if (!m.ruleId || typeof m.line !== 'number') continue
      out.push({
        file: relFile,
        line: m.line,
        column: m.column ?? 0,
        ruleId: m.ruleId,
        severity: m.severity ?? 1,
        message: truncate(m.message ?? ''),
      })
    }
  }

  // Determinism : tri lex (file, line, ruleId).
  out.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    if (a.line !== b.line) return a.line - b.line
    return a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0
  })

  return out
}

function truncate(s: string, max = 200): string {
  const oneline = s.replace(/[\t\n\r]+/g, ' ').trim()
  return oneline.length <= max ? oneline : oneline.slice(0, max - 3) + '...'
}
