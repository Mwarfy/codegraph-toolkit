/**
 * Drift Patterns — détecteurs de "drift agentique" (Phase 4 axe 4).
 *
 * Patterns que JE crée plus que les humains, à flagger pour me ralentir
 * au bon moment. Aucun outil ne fait ça parce qu'aucun outil n'est
 * conçu pour un agent.
 *
 * V1 (3 patterns) :
 *   1. **excessive-optional-params** : fonction avec > N params optionnels
 *      (default 5). "Future-proof non demandé" — l'agent ajoute des
 *      params au cas où, les call sites n'en passent que 1-2.
 *   2. **wrapper-superfluous** : function/method/arrow dont le body est
 *      `return otherFn(sameArgs)` — pas de transformation, pas de
 *      logging, juste un forward. Plus court d'inliner.
 *   3. **todo-no-owner** : `// TODO ...` sans `@username` ni `#NNN` ref
 *      à une issue. Code-debt fantôme qui dérive sans propriétaire.
 *
 * Convention zéro LLM : tout pattern est AST-déterministe + regex. Pas
 * d'appel externe, pas d'embeddings.
 *
 * Convention exempt : un commentaire `// drift-ok: <reason>` sur la
 * ligne PRÉCÉDANT le signal supprime le drift signal pour ce site.
 * Sert aux faux-positifs intentionnels (wrap pour logging futur, etc.).
 *
 * Faux positifs attendus : la mémoire inter-sessions (axe 3) est
 * critique. L'utilisateur peut marquer un site `false-positive` via
 * `codegraph_memory_mark` — le hook PostToolUse l'affichera dans la
 * section Mémoire avec la raison.
 */

import { type Project, type SourceFile, Node, SyntaxKind } from 'ts-morph'
import { makeIsExemptForMarker } from './_shared/ast-helpers.js'
import type { TodoMarker } from './todos.js'

export type DriftSignalKind =
  | 'excessive-optional-params'
  | 'wrapper-superfluous'
  | 'todo-no-owner'
  | 'deep-nesting'
  | 'empty-catch-no-comment'

export interface DriftSignal {
  kind: DriftSignalKind
  file: string
  line: number
  /** Court (≤120 chars), actionnable. */
  message: string
  /** 1=info, 2=worth-a-look, 3=fort. */
  severity: 1 | 2 | 3
  /** Détails spécifiques au kind (sérialisable JSON). */
  details?: Record<string, string | number | boolean>
}

export interface DriftPatternsFileBundle {
  signals: DriftSignal[]
}

export interface DriftPatternsOptions {
  /**
   * Seuil de "trop de params optionnels". Default 5 — au-delà la fonction
   * commence à être hard à appeler correctement et les call sites
   * tendent à n'en passer que 2-3.
   */
  optionalParamsThreshold?: number
  /**
   * Min LOC d'une wrapper function pour que le check démarre. Default 1
   * (toute fonction qui retourne juste un call est candidate). Utile
   * pour ignorer les wrappers très courts intentionnels (≤2 args).
   */
  wrapperMinArgs?: number
  /**
   * Profondeur max de nesting (if/for/while/switch/try) avant flag.
   * Default 5. Au-delà, la fonction devient une pyramide.
   */
  maxNestingDepth?: number
}

const DEFAULT_OPTIONAL_PARAMS_THRESHOLD = 5
const DEFAULT_WRAPPER_MIN_ARGS = 1
const DEFAULT_MAX_NESTING_DEPTH = 5

// ─── Pattern 1 + 2 : AST per-file ─────────────────────────────────────────

/**
 * Bundle per-file pour les patterns AST. Pattern 3 (TODO no-owner) est
 * traité dans l'aggregator car il n'a pas besoin d'AST.
 */
type DriftIsExempt = (line: number) => boolean
type FnLikeKind = 'function' | 'method' | 'arrow'

const NESTING_KINDS = new Set([
  SyntaxKind.IfStatement,
  SyntaxKind.ForStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.SwitchStatement,
  SyntaxKind.TryStatement,
])

interface DriftCheckCtx {
  relPath: string
  isExempt: DriftIsExempt
  optionalThreshold: number
  wrapperMinArgs: number
  maxNestingDepth: number
  signals: DriftSignal[]
}

function checkOptionalParams(
  name: string,
  params: ReadonlyArray<{ isOptional(): boolean }>,
  line: number,
  kind: FnLikeKind,
  ctx: DriftCheckCtx,
): void {
  if (ctx.isExempt(line)) return
  const optionalCount = params.filter((p) => p.isOptional()).length
  if (optionalCount <= ctx.optionalThreshold) return
  ctx.signals.push({
    kind: 'excessive-optional-params',
    file: ctx.relPath,
    line,
    message: `${name} a ${optionalCount} params optionnels (>${ctx.optionalThreshold}) — future-proof non demandé ?`,
    severity: 2,
    details: { name, optionalCount, kind },
  })
}

/**
 * Extract le single ReturnStatement.expression d'un body Block, ou
 * retourne directement l'expression d'un arrow concise body.
 * Returns null si la shape n'est pas un single-return.
 */
function singleReturnExpr(body: Node): Node | null {
  if (Node.isBlock(body)) {
    const stmts = body.getStatements()
    if (stmts.length !== 1) return null
    const stmt = stmts[0]
    if (!Node.isReturnStatement(stmt)) return null
    return stmt.getExpression() ?? null
  }
  return body
}

/**
 * Args doivent matcher les params un-pour-un : meme ordre, memes noms
 * d'identifiers (pas de spread, litteraux, transformations).
 */
function argsMatchParamsExactly(args: Node[], paramNames: string[]): boolean {
  if (args.length !== paramNames.length) return false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!Node.isIdentifier(arg)) return false
    if (arg.getText() !== paramNames[i]) return false
  }
  return true
}

function checkSuperfluousWrapper(
  name: string,
  paramNames: string[],
  body: Node | undefined,
  line: number,
  kind: FnLikeKind,
  ctx: DriftCheckCtx,
): void {
  if (ctx.isExempt(line)) return
  if (paramNames.length < ctx.wrapperMinArgs) return
  if (!body) return
  const returnExpr = singleReturnExpr(body)
  if (!returnExpr || !Node.isCallExpression(returnExpr)) return
  if (!argsMatchParamsExactly(returnExpr.getArguments(), paramNames)) return

  const callee = returnExpr.getExpression().getText()
  ctx.signals.push({
    kind: 'wrapper-superfluous',
    file: ctx.relPath,
    line,
    message: `${name} forward → ${callee} sans transformation — inliner ?`,
    severity: 1,
    details: { name, callee, kind },
  })
}

function computeMaxNestingDepth(body: Node): number {
  let maxDepth = 0
  const walk = (n: Node, depth: number): void => {
    if (NESTING_KINDS.has(n.getKind())) {
      depth++
      if (depth > maxDepth) maxDepth = depth
    }
    n.forEachChild((child) => walk(child, depth))
  }
  walk(body, 0)
  return maxDepth
}

function checkDeepNesting(
  name: string,
  body: Node | undefined,
  line: number,
  ctx: DriftCheckCtx,
): void {
  if (!body || ctx.isExempt(line)) return
  const maxDepth = computeMaxNestingDepth(body)
  if (maxDepth <= ctx.maxNestingDepth) return
  ctx.signals.push({
    kind: 'deep-nesting',
    file: ctx.relPath,
    line,
    message: `${name} : nesting profondeur ${maxDepth} (>${ctx.maxNestingDepth}) — guard-clauses ou extract-method ?`,
    severity: 2,
    details: { name, maxDepth },
  })
}

interface FnLikeNode {
  name: string
  body: Node | undefined
  line: number
  paramNames: string[]
  params: ReadonlyArray<{ isOptional(): boolean }>
  kind: FnLikeKind
}

function* iterateFnLikes(sf: SourceFile): Generator<FnLikeNode> {
  for (const fn of sf.getFunctions()) {
    const params = fn.getParameters()
    yield {
      name: fn.getName() ?? '(anonymous)',
      body: fn.getBody(),
      line: fn.getStartLineNumber(),
      paramNames: params.map((p) => p.getName()),
      params,
      kind: 'function',
    }
  }
  for (const cls of sf.getClasses()) {
    const className = cls.getName() ?? '(anonymous)'
    for (const method of cls.getMethods()) {
      const params = method.getParameters()
      yield {
        name: `${className}.${method.getName()}`,
        body: method.getBody(),
        line: method.getStartLineNumber(),
        paramNames: params.map((p) => p.getName()),
        params,
        kind: 'method',
      }
    }
  }
  for (const v of sf.getVariableDeclarations()) {
    const init = v.getInitializer()
    if (!init) continue
    if (!Node.isArrowFunction(init) && !Node.isFunctionExpression(init)) continue
    const params = init.getParameters()
    yield {
      name: v.getName(),
      body: init.getBody(),
      line: v.getStartLineNumber(),
      paramNames: params.map((p) => p.getName()),
      params,
      kind: 'arrow',
    }
  }
}

function detectEmptyCatchNoComment(sf: SourceFile, relPath: string, isExempt: DriftIsExempt, signals: DriftSignal[]): void {
  for (const cat of sf.getDescendantsOfKind(SyntaxKind.CatchClause)) {
    const block = cat.getBlock()
    if (block.getStatements().length > 0) continue  // catch fait quelque chose → OK
    const line = cat.getStartLineNumber()
    if (isExempt(line)) continue
    // Catch vide : check si un commentaire est dans le body (rationale).
    if (/\/\/|\/\*/.test(block.getFullText())) continue
    signals.push({
      kind: 'empty-catch-no-comment',
      file: relPath,
      line,
      message: `catch vide sans commentaire — avale silencieusement les erreurs ; ajouter rationale ou logger`,
      severity: 2,
    })
  }
}

export function extractDriftPatternsFileBundle(
  sf: SourceFile,
  relPath: string,
  options: DriftPatternsOptions = {},
): DriftPatternsFileBundle {
  const ctx: DriftCheckCtx = {
    relPath,
    isExempt: makeIsExemptForMarker(sf, 'drift-ok'),
    optionalThreshold: options.optionalParamsThreshold ?? DEFAULT_OPTIONAL_PARAMS_THRESHOLD,
    wrapperMinArgs: options.wrapperMinArgs ?? DEFAULT_WRAPPER_MIN_ARGS,
    maxNestingDepth: options.maxNestingDepth ?? DEFAULT_MAX_NESTING_DEPTH,
    signals: [],
  }

  for (const fn of iterateFnLikes(sf)) {
    checkOptionalParams(fn.name, fn.params, fn.line, fn.kind, ctx)
    checkSuperfluousWrapper(fn.name, fn.paramNames, fn.body, fn.line, fn.kind, ctx)
    checkDeepNesting(fn.name, fn.body, fn.line, ctx)
  }
  detectEmptyCatchNoComment(sf, relPath, ctx.isExempt, ctx.signals)

  return { signals: ctx.signals }
}

// ─── Pattern 3 : TODO no owner (regex sur snapshot.todos existant) ────────

/**
 * Détecte les TODO/FIXME/HACK/XXX/NOTE sans `@username` (owner) ni
 * `#NNN` (issue ref). Un TODO sans propriétaire est un fantôme : il
 * dérive sans qu'on s'en aperçoive.
 *
 * Patterns reconnus comme "OK" :
 *   `// TODO(@alice): ...`
 *   `// TODO @alice: ...`
 *   `// TODO #123 ...`
 *   `// FIXME(#456): ...`
 *   `// HACK @user #789 ...`
 */
export function todoToDriftSignal(todo: TodoMarker): DriftSignal | null {
  const msg = todo.message ?? ''
  // Regex permissif : @user OU #NNN n'importe où dans le message.
  const hasOwner = /@\w+/.test(msg)
  const hasIssueRef = /#\d+/.test(msg)
  if (hasOwner || hasIssueRef) return null
  return {
    kind: 'todo-no-owner',
    file: todo.file,
    line: todo.line,
    message: `${todo.tag} sans @owner ni #issue : "${msg.slice(0, 60)}"`,
    severity: 1,
    details: { tag: todo.tag, fullMessage: msg.slice(0, 200) },
  }
}

// ─── Aggregator ────────────────────────────────────────────────────────────

export async function analyzeDriftPatterns(
  rootDir: string,
  files: string[],
  project: Project,
  todos: TodoMarker[] | undefined,
  options: DriftPatternsOptions = {},
): Promise<DriftSignal[]> {
  const fileSet = new Set(files)
  const all: DriftSignal[] = []

  // Patterns 1 + 2 : AST per-file
  for (const sf of project.getSourceFiles()) {
    const rel = relativize(sf.getFilePath(), rootDir)
    if (!rel || !fileSet.has(rel)) continue
    // Skip les fichiers de test — les wrappers/params optionnels sont
    // souvent intentionnels (mocks, helpers de fixture).
    if (/\.test\.tsx?$|\.spec\.tsx?$|(^|\/)tests?\//.test(rel)) continue
    const bundle = extractDriftPatternsFileBundle(sf, rel, options)
    all.push(...bundle.signals)
  }

  // Pattern 3 : TODO no-owner depuis snapshot.todos
  if (todos) {
    for (const todo of todos) {
      const signal = todoToDriftSignal(todo)
      if (signal) all.push(signal)
    }
  }

  // Tri stable : file → line → kind
  all.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    if (a.line !== b.line) return a.line - b.line
    return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0
  })

  return all
}

function relativize(absPath: string, rootDir: string): string | null {
  const normalized = absPath.replace(/\\/g, '/')
  const rootNormalized = rootDir.replace(/\\/g, '/')
  if (!normalized.startsWith(rootNormalized)) return null
  return normalized.slice(rootNormalized.length + 1)
}
