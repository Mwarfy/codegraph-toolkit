/**
 * Eval/Function-constructor calls — détecteur déterministe AST.
 *
 * Capture les call-sites de :
 *   - `eval(...)` (global)
 *   - `new Function(...)` (Function constructor)
 *
 * Pourquoi : ces deux primitives compilent et exécutent du code à
 * l'exécution. Vecteurs RCE classiques si l'argument est user-controlled.
 * Aucun usage légitime dans 99% des codebases applicatifs (les rares
 * vrais usages — sandbox, REPL, code-gen — sont volontaires et exemptables).
 *
 * Pattern ADR-005 : per-file bundle → agrégat trivial. Stable sur
 * fileContent → cacheable Salsa.
 */

import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import { type Project, type SourceFile, Node, SyntaxKind } from 'ts-morph'
import { findContainingSymbol } from './_shared/ast-helpers.js'
import { runPerSourceFileExtractor } from '../parallel/per-source-file-extractor.js'

export type EvalCallKind = 'eval' | 'function-constructor'

export interface EvalCall {
  kind: EvalCallKind
  file: string
  line: number
  /** Le symbole englobant si trouvable (function/method name). Vide sinon. */
  containingSymbol: string
}

export interface EvalCallsFileBundle {
  calls: EvalCall[]
}

/**
 * Bundle per-file : extrait les calls eval / new Function du fichier.
 */
const TEST_FIXTURE_RE = /(\.test\.tsx?|\.spec\.tsx?|(^|\/)tests?\/|(^|\/)__tests__\/|(^|\/)fixtures?\/)/

export function extractEvalCallsFileBundle(
  sf: SourceFile,
  relPath: string,
): EvalCallsFileBundle {
  // Skip test fixtures — eval() est intentionnel dans les inputs
  // synthétiques destinés à tester les détecteurs taint / no-eval
  // eux-mêmes. Sans ce skip, le toolkit auto-flag ses propres
  // fixtures comme dette.
  if (TEST_FIXTURE_RE.test(relPath)) return { calls: [] }
  const calls: EvalCall[] = []

  // 1. eval(...) — CallExpression dont le callee est l'identifier 'eval'.
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression()
    if (Node.isIdentifier(callee) && callee.getText() === 'eval') {
      calls.push({
        kind: 'eval',
        file: relPath,
        line: call.getStartLineNumber(),
        containingSymbol: findContainingSymbol(call),
      })
    }
  }

  // 2. new Function(...) — NewExpression dont le callee est 'Function'.
  for (const newExpr of sf.getDescendantsOfKind(SyntaxKind.NewExpression)) {
    const callee = newExpr.getExpression()
    if (Node.isIdentifier(callee) && callee.getText() === 'Function') {
      calls.push({
        kind: 'function-constructor',
        file: relPath,
        line: newExpr.getStartLineNumber(),
        containingSymbol: findContainingSymbol(newExpr),
      })
    }
  }

  return { calls }
}

/**
 * Remonte l'AST pour trouver le nom du symbole englobant (function /
 * method / arrow assignée). Retourne '' si rien de nommé n'est trouvé
 * (ex: callback anonyme top-level).
 */

/**
 * Aggregator : tous les eval/Function calls du projet, triés.
 */
/**
 * Worker entrypoint Phase γ.2.
 */
export function extractEvalCallsForWorker(sf: SourceFile, relPath: string): EvalCall[] {
  return extractEvalCallsFileBundle(sf, relPath).calls
}

const EVAL_CALLS_WORKER_MODULE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'eval-calls.js',
)

export async function analyzeEvalCalls(
  rootDir: string,
  files: string[],
  project: Project,
): Promise<EvalCall[]> {
  const r = await runPerSourceFileExtractor<EvalCallsFileBundle, EvalCall>({
    project,
    files,
    rootDir,
    extractor: extractEvalCallsFileBundle,
    selectItems: (b) => b.calls,
    sortKey: (c) => `${c.file}:${String(c.line).padStart(8, '0')}`,
    workerModule: EVAL_CALLS_WORKER_MODULE,
    workerExport: 'extractEvalCallsForWorker',
  })
  return r.items
}

function relativize(absPath: string, rootDir: string): string | null {
  const normalized = absPath.replace(/\\/g, '/')
  const rootNormalized = rootDir.replace(/\\/g, '/')
  if (!normalized.startsWith(rootNormalized)) return null
  return normalized.slice(rootNormalized.length + 1)
}
