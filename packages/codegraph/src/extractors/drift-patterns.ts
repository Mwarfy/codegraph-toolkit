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

import { type Project, type SourceFile, Node } from 'ts-morph'
import type { TodoMarker } from './todos.js'

export type DriftSignalKind =
  | 'excessive-optional-params'
  | 'wrapper-superfluous'
  | 'todo-no-owner'

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
}

const DEFAULT_OPTIONAL_PARAMS_THRESHOLD = 5
const DEFAULT_WRAPPER_MIN_ARGS = 1

// ─── Pattern 1 + 2 : AST per-file ─────────────────────────────────────────

/**
 * Bundle per-file pour les patterns AST. Pattern 3 (TODO no-owner) est
 * traité dans l'aggregator car il n'a pas besoin d'AST.
 */
export function extractDriftPatternsFileBundle(
  sf: SourceFile,
  relPath: string,
  options: DriftPatternsOptions = {},
): DriftPatternsFileBundle {
  const optionalThreshold = options.optionalParamsThreshold ?? DEFAULT_OPTIONAL_PARAMS_THRESHOLD
  const wrapperMinArgs = options.wrapperMinArgs ?? DEFAULT_WRAPPER_MIN_ARGS
  const signals: DriftSignal[] = []

  // Construire un index ligne→texte pour le check `// drift-ok:` exempt.
  const lines = sf.getFullText().split('\n')
  const isExempt = (line: number): boolean => {
    // Regarde la ligne PRÉCÉDANT (line-1) car drift-ok est en commentaire au-dessus.
    if (line < 2 || line - 2 >= lines.length) return false
    const prev = lines[line - 2]
    return /\/\/\s*drift-ok\b/.test(prev)
  }

  // Helper : check params optionnels sur n'importe quel "function-like".
  const checkParams = (
    name: string,
    params: ReadonlyArray<{ isOptional(): boolean }>,
    line: number,
    kind: 'function' | 'method' | 'arrow',
  ): void => {
    if (isExempt(line)) return
    const optionalCount = params.filter((p) => p.isOptional()).length
    if (optionalCount > optionalThreshold) {
      signals.push({
        kind: 'excessive-optional-params',
        file: relPath,
        line,
        message: `${name} a ${optionalCount} params optionnels (>${optionalThreshold}) — future-proof non demandé ?`,
        severity: 2,
        details: { name, optionalCount, kind },
      })
    }
  }

  // Helper : check wrapper superflu.
  // Un wrapper superflu = body = single ReturnStatement qui call B avec
  // EXACTEMENT les mêmes args (même ordre, mêmes noms d'identifiers).
  const checkWrapper = (
    name: string,
    paramNames: string[],
    body: Node | undefined,
    line: number,
    kind: 'function' | 'method' | 'arrow',
  ): void => {
    if (isExempt(line)) return
    if (paramNames.length < wrapperMinArgs) return
    if (!body) return

    let returnExpr: Node | undefined
    if (Node.isBlock(body)) {
      const stmts = body.getStatements()
      if (stmts.length !== 1) return
      const stmt = stmts[0]
      if (!Node.isReturnStatement(stmt)) return
      returnExpr = stmt.getExpression()
    } else {
      // Arrow concise body — directement l'expression.
      returnExpr = body
    }
    if (!returnExpr || !Node.isCallExpression(returnExpr)) return

    const args = returnExpr.getArguments()
    // Args doivent matcher les params un-pour-un (pas de spread,
    // littéraux, transformations).
    if (args.length !== paramNames.length) return
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (!Node.isIdentifier(arg)) return
      if (arg.getText() !== paramNames[i]) return
    }

    const callee = returnExpr.getExpression().getText()
    signals.push({
      kind: 'wrapper-superfluous',
      file: relPath,
      line,
      message: `${name} forward → ${callee} sans transformation — inliner ?`,
      severity: 1,
      details: { name, callee, kind },
    })
  }

  // FunctionDeclarations
  for (const fn of sf.getFunctions()) {
    const name = fn.getName() ?? '(anonymous)'
    const line = fn.getStartLineNumber()
    const params = fn.getParameters()
    checkParams(name, params, line, 'function')
    checkWrapper(
      name,
      params.map((p) => p.getName()),
      fn.getBody(),
      line,
      'function',
    )
  }

  // ClassMethods
  for (const cls of sf.getClasses()) {
    const className = cls.getName() ?? '(anonymous)'
    for (const method of cls.getMethods()) {
      const name = `${className}.${method.getName()}`
      const line = method.getStartLineNumber()
      const params = method.getParameters()
      checkParams(name, params, line, 'method')
      checkWrapper(
        name,
        params.map((p) => p.getName()),
        method.getBody(),
        line,
        'method',
      )
    }
  }

  // Arrow / Function expressions assignés à variable
  for (const v of sf.getVariableDeclarations()) {
    const initializer = v.getInitializer()
    if (!initializer) continue
    if (!Node.isArrowFunction(initializer) && !Node.isFunctionExpression(initializer)) continue
    const name = v.getName()
    const line = v.getStartLineNumber()
    const params = initializer.getParameters()
    checkParams(name, params, line, 'arrow')
    checkWrapper(
      name,
      params.map((p) => p.getName()),
      initializer.getBody(),
      line,
      'arrow',
    )
  }

  return { signals }
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
