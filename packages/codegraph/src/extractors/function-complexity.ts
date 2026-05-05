/**
 * Function Complexity — McCabe + Cognitive (Top-5 graph theory uplift).
 *
 * Calcule pour chaque fonction :
 *   - cyclomatic (McCabe 1976) : 1 + branches lineaires
 *   - cognitive  (SonarQube)   : branches + nesting (penalise nesting expo)
 *
 * Difference :
 *   10 if seq           → cyclomatic=10, cognitive=10
 *   3 if dans for/while → cyclomatic=4,  cognitive=12 (1+1+ 1+2 + 1+3 + 1)
 *
 * Cognitive matche mieux la difficulte humaine de lecture/maintenance.
 * Empiriquement plus correle aux bugs (Campbell 2018).
 *
 * Pattern exempt : `// complexity-ok: <reason>` ligne precedente.
 */

import { type Project, type SourceFile, Node, SyntaxKind } from 'ts-morph'
import { makeIsExemptForMarker } from './_shared/ast-helpers.js'
import { runPerSourceFileExtractor } from '../parallel/per-source-file-extractor.js'

export interface FunctionComplexity {
  file: string
  name: string
  line: number
  cyclomatic: number
  cognitive: number
  containingClass: string  // '' si pas une method
}

import { computeCyclomatic, computeCognitive } from './_shared/complexity.js'

const TEST_FILE_RE = /(\.test\.tsx?|\.spec\.tsx?|(^|\/)tests?\/|(^|\/)fixtures?\/)/

interface FnLikeWithBody {
  name: string
  body: Node
  line: number
  containingClass: string
}

function* iterateFnLikesWithBody(sf: SourceFile): Generator<FnLikeWithBody> {
  for (const fn of sf.getFunctions()) {
    const body = fn.getBody()
    if (!body) continue
    yield {
      name: fn.getName() ?? '(anonymous)',
      body,
      line: fn.getStartLineNumber(),
      containingClass: '',
    }
  }
  for (const cls of sf.getClasses()) {
    const className = cls.getName() ?? '(anonymous)'
    for (const m of cls.getMethods()) {
      const body = m.getBody()
      if (!body) continue
      yield {
        name: m.getName(),
        body,
        line: m.getStartLineNumber(),
        containingClass: className,
      }
    }
  }
  for (const v of sf.getVariableDeclarations()) {
    const init = v.getInitializer()
    if (!init) continue
    if (!Node.isArrowFunction(init) && !Node.isFunctionExpression(init)) continue
    const body = init.getBody()
    if (!body) continue
    yield {
      name: v.getName(),
      body,
      line: v.getStartLineNumber(),
      containingClass: '',
    }
  }
}

export function extractFunctionComplexityFileBundle(
  sf: SourceFile,
  relPath: string,
): FunctionComplexity[] {
  if (TEST_FILE_RE.test(relPath)) return []
  const isExempt = makeIsExemptForMarker(sf, 'complexity-ok')
  const out: FunctionComplexity[] = []
  for (const fn of iterateFnLikesWithBody(sf)) {
    if (isExempt(fn.line)) continue
    out.push({
      file: relPath,
      name: fn.name,
      line: fn.line,
      cyclomatic: computeCyclomatic(fn.body),
      cognitive: computeCognitive(fn.body),
      containingClass: fn.containingClass,
    })
  }
  return out
}

export async function analyzeFunctionComplexity(
  rootDir: string,
  files: string[],
  project: Project,
): Promise<FunctionComplexity[]> {
  const r = await runPerSourceFileExtractor<FunctionComplexity[], FunctionComplexity>({
    project,
    files,
    rootDir,
    extractor: extractFunctionComplexityFileBundle,
    selectItems: (items) => items,
    sortKey: (c) => `${c.file}:${String(c.line).padStart(8, '0')}`,
  })
  return r.items
}

function relativize(absPath: string, rootDir: string): string | null {
  const normalized = absPath.replace(/\\/g, '/')
  const rootNormalized = rootDir.replace(/\\/g, '/')
  if (!normalized.startsWith(rootNormalized)) return null
  return normalized.slice(rootNormalized.length + 1)
}
