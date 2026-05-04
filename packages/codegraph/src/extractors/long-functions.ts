/**
 * Long Functions Detector — complement déterministe de complexity.
 *
 * Capture les fonctions trop longues (>N LOC, default 100) — qu'elles
 * soient cycliquement complexes ou pas. La complexité cyclomatique
 * détecte les fonctions branchantes. Long-functions détecte la verbosité
 * brute : 200 lignes de code séquentiel sans branches sont aussi un
 * candidat au refactor.
 *
 * Sortie : liste de { file, name, line, loc } triée par loc descendant.
 *
 * Pattern ADR-005 : extractLongFunctionsFileBundle(sf, relPath, threshold)
 * per-file → agrégat concat trivial. Stable sur fileContent.
 */

import { type Project, type SourceFile, Node } from 'ts-morph'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import { runPerSourceFileExtractor } from '../parallel/per-source-file-extractor.js'

export interface LongFunction {
  file: string
  name: string
  line: number
  loc: number
  /** Type de déclaration : function | method | arrow */
  kind: 'function' | 'method' | 'arrow'
}

export interface LongFunctionsFileBundle {
  functions: LongFunction[]
}

export interface LongFunctionsOptions {
  /** Seuil minimum de LOC pour qu'une fonction soit "long". Default: 100. */
  threshold?: number
}

const DEFAULT_THRESHOLD = 100

/**
 * Bundle per-file : extrait les fonctions au-delà du seuil.
 */
interface LongFnScope {
  name: string
  body: Node
  line: number
  kind: LongFunction['kind']
}

function* iterateLongFnScopes(sf: SourceFile): Generator<LongFnScope> {
  for (const fn of sf.getFunctions()) {
    const body = fn.getBody()
    if (!body) continue
    yield {
      name: fn.getName() ?? '(anonymous)',
      body,
      line: fn.getStartLineNumber(),
      kind: 'function',
    }
  }
  for (const cls of sf.getClasses()) {
    const className = cls.getName() ?? '(anonymous)'
    for (const method of cls.getMethods()) {
      const body = method.getBody()
      if (!body) continue
      yield {
        name: `${className}.${method.getName()}`,
        body,
        line: method.getStartLineNumber(),
        kind: 'method',
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
      kind: 'arrow',
    }
  }
}

export function extractLongFunctionsFileBundle(
  sf: SourceFile,
  relPath: string,
  threshold: number = DEFAULT_THRESHOLD,
): LongFunctionsFileBundle {
  const functions: LongFunction[] = []
  for (const fn of iterateLongFnScopes(sf)) {
    const loc = countLoc(fn.body.getText())
    if (loc < threshold) continue
    functions.push({
      file: relPath,
      name: fn.name,
      line: fn.line,
      loc,
      kind: fn.kind,
    })
  }
  return { functions }
}

/**
 * Compte les lignes effectives (non-vides, non-comments-only) d'un block
 * de texte. Heuristique simple — on veut "ce qui pèse à lire".
 */
function countLoc(bodyText: string): number {
  const lines = bodyText.split('\n')
  let count = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (trimmed === '{' || trimmed === '}') continue
    if (trimmed.startsWith('//')) continue
    if (trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.endsWith('*/')) continue
    count++
  }
  return count
}

/**
 * Worker entrypoint Phase γ.2 — wrap extract + select pour retourner Item[]
 * directement. Loadé depuis source-file-worker-runner.ts en worker.
 */
export function extractLongFunctionsForWorker(
  sf: SourceFile,
  relPath: string,
  options?: { threshold?: number },
): LongFunction[] {
  const threshold = options?.threshold ?? DEFAULT_THRESHOLD
  return extractLongFunctionsFileBundle(sf, relPath, threshold).functions
}

const LONG_FUNCTIONS_WORKER_MODULE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'long-functions.js',
)

/**
 * Analyze all files, retourne les long-functions triées par LOC descendant.
 */
export async function analyzeLongFunctions(
  rootDir: string,
  files: string[],
  project: Project,
  options: LongFunctionsOptions = {},
): Promise<LongFunction[]> {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD
  // Sort canonique par (file, line) pour le pattern monoïdal — puis re-sort
  // par loc desc en main thread (sort secondaire). Le sortKey monoïdal
  // garantit le déterminisme cross-thread ; le re-sort par loc est juste
  // une présentation pour les humains qui veulent les top long fns en haut.
  const r = await runPerSourceFileExtractor<{ items: LongFunction[] }, LongFunction>({
    project,
    files,
    rootDir,
    extractor: (sf, rel) => ({ items: extractLongFunctionsFileBundle(sf, rel, threshold).functions }),
    selectItems: (b) => b.items,
    sortKey: (l) => `${l.file}:${String(l.line).padStart(8, '0')}`,
    workerModule: LONG_FUNCTIONS_WORKER_MODULE,
    workerExport: 'extractLongFunctionsForWorker',
    workerExtractorOptions: { threshold },
  })
  // Re-sort par loc desc — pure JS sort, déterministe (loc ties broken par
  // l'ordre canonique injecté ci-dessus).
  return [...r.items].sort((a, b) => b.loc - a.loc)
}

function relativize(absPath: string, rootDir: string): string | null {
  const normalized = absPath.replace(/\\/g, '/')
  const rootNormalized = rootDir.replace(/\\/g, '/')
  if (!normalized.startsWith(rootNormalized)) return null
  return normalized.slice(rootNormalized.length + 1)
}

void path
