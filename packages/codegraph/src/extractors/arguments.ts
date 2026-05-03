/**
 * Arguments + FunctionParam — facts pour cross-function taint analysis
 * (Phase 4 Tier 14).
 *
 * Émet 2 relations :
 *
 *   - **TaintedArgumentToCall(callerFile, callerSym, callee, paramIdx, source)**
 *     Capture les call-sites OU un argument à l'index `paramIdx` est :
 *     a) une expression user-input directe (`req.body.x`, `process.env.X`)
 *     b) une variable identifier qui est elle-même taintée (Tier 11)
 *
 *   - **FunctionParam(file, sym, paramName, paramIndex)**
 *     Déclarations de paramètres pour chaque fonction. Permet de joindre
 *     "appelé avec arg tainté à idx I" + "param à idx I s'appelle X dans
 *     fonction F" → "X dans fonction F est tainté".
 *
 * Combiné avec le composite Datalog :
 *   ```dl
 *   TaintedParam(F, S, P, Src) :-
 *       TaintedArgumentToCall(_, _, S, I, Src),
 *       FunctionParam(F, S, P, I).
 *   ```
 *
 * On obtient du **vrai cross-function taint** : un user input passé à une
 * fonction puis utilisé par cette fonction comme arg d'un sink est
 * detecté, même si la fonction de pré-validation n'est pas dans le même
 * file.
 *
 * Limites V1 :
 *   - Match par nom de fonction (pas qualified path) : collisions possibles.
 *   - Pas de tracking au-delà de 1 hop (chaîne de 2+ fonctions perd la
 *     propagation, sauf à étendre avec une closure transitive Datalog).
 *   - Pas de re-assignement tracking dans le body de la callee.
 */

import { type Project, type SourceFile, Node, SyntaxKind } from 'ts-morph'
import type { TaintSourceKind } from './tainted-vars.js'

export interface TaintedArgumentToCall {
  callerFile: string
  callerSymbol: string
  callee: string
  paramIndex: number
  source: TaintSourceKind
}

export interface FunctionParam {
  file: string
  symbol: string
  paramName: string
  paramIndex: number
}

export interface ArgumentsFileBundle {
  taintedArgs: TaintedArgumentToCall[]
  params: FunctionParam[]
}

const TEST_FILE_RE = /(\.test\.tsx?|\.spec\.tsx?|(^|\/)tests?\/|(^|\/)fixtures?\/)/

const SOURCE_PATTERNS: Array<{ kind: TaintSourceKind; re: RegExp }> = [
  { kind: 'req.body',     re: /^(req|request|ctx\.req)\.body($|\.|\[)/ },
  { kind: 'req.query',    re: /^(req|request|ctx\.req)\.query($|\.|\[)/ },
  { kind: 'req.params',   re: /^(req|request|ctx\.req)\.params($|\.|\[)/ },
  { kind: 'req.headers',  re: /^(req|request|ctx\.req)\.headers($|\.|\[)/ },
  { kind: 'process.argv', re: /^process\.argv($|\.|\[)/ },
  { kind: 'process.env',  re: /^process\.env($|\.|\[)/ },
]

function matchSource(text: string): TaintSourceKind | null {
  const t = text.trim()
  for (const { kind, re } of SOURCE_PATTERNS) {
    if (re.test(t)) return kind
  }
  return null
}

interface FnScope {
  name: string
  fnNode: Node
  params: ReadonlyArray<{ getName(): string }>
}

/**
 * Itère les function-like scopes : décl, méthodes de classe, arrows assignés.
 * Yield contient le nom symbolique + le node body + la liste de params.
 * Skip les fn anonymes top-level (pas de name) — leurs params/args ne peuvent
 * pas être attribués à un symbole stable.
 */
function* iterateFnScopes(sf: SourceFile): Generator<FnScope> {
  for (const fn of sf.getFunctions()) {
    const name = fn.getName()
    if (!name) continue
    yield { name, fnNode: fn, params: fn.getParameters() }
  }
  for (const cls of sf.getClasses()) {
    const className = cls.getName() ?? '(anonymous)'
    for (const method of cls.getMethods()) {
      yield {
        name: `${className}.${method.getName()}`,
        fnNode: method,
        params: method.getParameters(),
      }
    }
  }
  for (const v of sf.getVariableDeclarations()) {
    const init = v.getInitializer()
    if (!init) continue
    if (!Node.isArrowFunction(init) && !Node.isFunctionExpression(init)) continue
    yield { name: v.getName(), fnNode: init, params: init.getParameters() }
  }
}

export function extractArgumentsFileBundle(
  sf: SourceFile,
  relPath: string,
): ArgumentsFileBundle {
  if (TEST_FILE_RE.test(relPath)) return { taintedArgs: [], params: [] }
  const taintedArgs: TaintedArgumentToCall[] = []
  const params: FunctionParam[] = []

  for (const scope of iterateFnScopes(sf)) {
    pushFunctionParams(scope, relPath, params)
    collectArgsInScope(scope, relPath, taintedArgs)
  }

  return { taintedArgs, params }
}

// ─── Pass 1: FunctionParam emit ─────────────────────────────────────────────

function pushFunctionParams(scope: FnScope, relPath: string, params: FunctionParam[]): void {
  for (let i = 0; i < scope.params.length; i++) {
    const name = scope.params[i].getName()
    if (!name) continue
    params.push({ file: relPath, symbol: scope.name, paramName: name, paramIndex: i })
  }
}

// ─── Pass 2: tainted args dans le scope ─────────────────────────────────────

/**
 * Pour chaque scope, on construit un Map<varName, source> des vars taintées
 * (var = req.body.x). On fold-in la détection au lieu de dépendre de
 * l'extracteur tainted-vars — keeps cet extracteur self-contained.
 */
function collectArgsInScope(
  scope: FnScope,
  relPath: string,
  taintedArgs: TaintedArgumentToCall[],
): void {
  const taintedVars = collectTaintedVarsLocally(scope.fnNode)
  for (const call of scope.fnNode.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const calleeText = readCalleeText(call.getExpression())
    if (!calleeText) continue
    scanArgsForTaint(call.getArguments(), calleeText, scope.name, relPath, taintedVars, taintedArgs)
  }
}

function collectTaintedVarsLocally(fnNode: Node): Map<string, TaintSourceKind> {
  const taintedVars = new Map<string, TaintSourceKind>()
  for (const v of fnNode.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = v.getInitializer()
    if (!init) continue
    const src = matchSource(init.getText())
    if (!src) continue
    const nameNode = v.getNameNode()
    if (!Node.isIdentifier(nameNode)) continue
    taintedVars.set(nameNode.getText(), src)
  }
  return taintedVars
}

function readCalleeText(callee: Node): string | null {
  if (Node.isIdentifier(callee)) return callee.getText()
  if (Node.isPropertyAccessExpression(callee)) return callee.getName()
  return null
}

/**
 * Pour chaque arg : check (a) si c'est une expression user-input directe
 * (req.body.X), sinon (b) si c'est un identifier dont la var est taintée
 * dans ce scope. Push un TaintedArgumentToCall dans les deux cas.
 */
function scanArgsForTaint(
  args: Node[],
  calleeText: string,
  callerSymbol: string,
  relPath: string,
  taintedVars: Map<string, TaintSourceKind>,
  taintedArgs: TaintedArgumentToCall[],
): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const directSrc = matchSource(arg.getText())
    if (directSrc) {
      taintedArgs.push({ callerFile: relPath, callerSymbol, callee: calleeText, paramIndex: i, source: directSrc })
      continue
    }
    if (Node.isIdentifier(arg)) {
      const varSrc = taintedVars.get(arg.getText())
      if (varSrc) {
        taintedArgs.push({ callerFile: relPath, callerSymbol, callee: calleeText, paramIndex: i, source: varSrc })
      }
    }
  }
}

export async function analyzeArguments(
  rootDir: string,
  files: string[],
  project: Project,
): Promise<{ taintedArgs: TaintedArgumentToCall[]; params: FunctionParam[] }> {
  const fileSet = new Set(files)
  const allArgs: TaintedArgumentToCall[] = []
  const allParams: FunctionParam[] = []

  for (const sf of project.getSourceFiles()) {
    const rel = relativize(sf.getFilePath(), rootDir)
    if (!rel || !fileSet.has(rel)) continue
    const bundle = extractArgumentsFileBundle(sf, rel)
    allArgs.push(...bundle.taintedArgs)
    allParams.push(...bundle.params)
  }

  allArgs.sort((a, b) =>
    a.callerFile !== b.callerFile
      ? (a.callerFile < b.callerFile ? -1 : 1)
      : a.callerSymbol < b.callerSymbol ? -1 : a.callerSymbol > b.callerSymbol ? 1 : 0,
  )
  allParams.sort((a, b) =>
    a.file !== b.file
      ? (a.file < b.file ? -1 : 1)
      : a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : a.paramIndex - b.paramIndex,
  )

  return { taintedArgs: allArgs, params: allParams }
}

function relativize(absPath: string, rootDir: string): string | null {
  const normalized = absPath.replace(/\\/g, '/')
  const rootNormalized = rootDir.replace(/\\/g, '/')
  if (!normalized.startsWith(rootNormalized)) return null
  return normalized.slice(rootNormalized.length + 1)
}
