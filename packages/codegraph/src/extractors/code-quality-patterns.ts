/**
 * Code Quality Patterns — orchestrateur des 4 sous-détecteurs (Phase 5
 * Tier 17).
 *
 * Bundle 4 patterns capturés en un AST walk par sous-module dédié :
 *
 *   1. RegexLiteral       (_internal/code-quality/regex-literals.ts)
 *      `RegExpLiteral` + `new RegExp(literal)` avec drapeau ReDoS.
 *
 *   2. TryCatchSwallow    (_internal/code-quality/try-catch-swallow.ts)
 *      Catch blocks empty / log-only / no-rethrow → erreurs silencieuses.
 *
 *   3. AwaitInLoop        (_internal/code-quality/await-in-loop.ts)
 *      `await` dans un loop direct → sequential I/O bottleneck.
 *
 *   4. AllocationInLoop   (_internal/code-quality/allocation-in-loop.ts)
 *      `[]` / `{}` / `new X(...)` par itération → GC pressure.
 *
 * Pattern ADR-005 : per-file bundle → agrégat trivial. Stable sur
 * fileContent → cacheable Salsa (cf. ../incremental/code-quality-patterns.ts).
 *
 * Refonte mai 2026 : split en 4 sous-modules + fix bug REDOS heuristic
 * (matchait `(?:...)?` à tort ; les groupes optionnels ne sont pas
 * catastrophic). META-CRITICAL-INSTABILITY résolu (chaos amplifier
 * éliminé + tests ajoutés).
 */

import { type Project, type SourceFile } from 'ts-morph'
import { TEST_FILE_RE, makeIsExempt } from './_internal/code-quality/_helpers.js'
import {
  extractRegexLiterals,
  type RegexLiteralFact,
} from './_internal/code-quality/regex-literals.js'
import {
  extractTryCatchSwallows,
  type TryCatchSwallowFact,
} from './_internal/code-quality/try-catch-swallow.js'
import {
  extractAwaitInLoops,
  type AwaitInLoopFact,
} from './_internal/code-quality/await-in-loop.js'
import {
  extractAllocationInLoops,
  type AllocationInLoopFact,
} from './_internal/code-quality/allocation-in-loop.js'

export type {
  RegexLiteralFact,
  TryCatchSwallowFact,
  AwaitInLoopFact,
  AllocationInLoopFact,
}

export interface CodeQualityPatternsBundle {
  regexLiterals: RegexLiteralFact[]
  tryCatchSwallows: TryCatchSwallowFact[]
  awaitInLoops: AwaitInLoopFact[]
  allocationInLoops: AllocationInLoopFact[]
}

export function extractCodeQualityPatternsFileBundle(
  sf: SourceFile,
  relPath: string,
): CodeQualityPatternsBundle {
  if (TEST_FILE_RE.test(relPath)) {
    return { regexLiterals: [], tryCatchSwallows: [], awaitInLoops: [], allocationInLoops: [] }
  }
  const isExempt = makeIsExempt(sf)
  return {
    regexLiterals: extractRegexLiterals(sf, relPath, isExempt),
    tryCatchSwallows: extractTryCatchSwallows(sf, relPath, isExempt),
    awaitInLoops: extractAwaitInLoops(sf, relPath, isExempt),
    allocationInLoops: extractAllocationInLoops(sf, relPath, isExempt),
  }
}

export interface CodeQualityPatternsAggregated {
  regexLiterals: RegexLiteralFact[]
  tryCatchSwallows: TryCatchSwallowFact[]
  awaitInLoops: AwaitInLoopFact[]
  allocationInLoops: AllocationInLoopFact[]
}

export async function analyzeCodeQualityPatterns(
  rootDir: string,
  files: string[],
  project: Project,
): Promise<CodeQualityPatternsAggregated> {
  const fileSet = new Set(files)
  const out: CodeQualityPatternsAggregated = {
    regexLiterals: [], tryCatchSwallows: [], awaitInLoops: [], allocationInLoops: [],
  }
  for (const sf of project.getSourceFiles()) {
    const rel = relativize(sf.getFilePath(), rootDir)
    if (!rel || !fileSet.has(rel)) continue
    const bundle = extractCodeQualityPatternsFileBundle(sf, rel)
    out.regexLiterals.push(...bundle.regexLiterals)
    out.tryCatchSwallows.push(...bundle.tryCatchSwallows)
    out.awaitInLoops.push(...bundle.awaitInLoops)
    out.allocationInLoops.push(...bundle.allocationInLoops)
  }
  const sortFn = (a: { file: string; line: number }, b: { file: string; line: number }) =>
    a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.line - b.line
  out.regexLiterals.sort(sortFn)
  out.tryCatchSwallows.sort(sortFn)
  out.awaitInLoops.sort(sortFn)
  out.allocationInLoops.sort(sortFn)
  return out
}

function relativize(absPath: string, rootDir: string): string | null {
  const normalized = absPath.replace(/\\/g, '/')
  const rootNormalized = rootDir.replace(/\\/g, '/')
  if (!normalized.startsWith(rootNormalized)) return null
  return normalized.slice(rootNormalized.length + 1)
}
