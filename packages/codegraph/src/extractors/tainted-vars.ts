// ADR-007
/**
 * Tainted variables — détecteur déterministe AST (Phase 4 Tier 11).
 *
 * Implémente du **variable tracking lite** : détecte les variables qui
 * reçoivent un user input non-sanitizé (req.body.*, req.query.*, etc.)
 * puis identifie les call sites où ces variables sont passées en argument.
 *
 * Différence vs `taint-sinks.ts` (Tier 10) :
 *   - Tier 10 : identifie les SINKS (db.query, eval, etc.) sans savoir
 *     ce qui leur est passé.
 *   - Tier 11 : identifie les VARIABLES TAINTÉES (assignées à req.body.*)
 *     ET les call-sites qui les passent en argument.
 *
 * Combiné avec un composite Datalog : "si TaintedArgCall(file, line, sink)
 * ∩ TaintSink(file, line, ...)" → violation à la même position = vrai
 * positif (pas juste la file-level approximation Tier 10).
 *
 * Limites V1 (lite) :
 *   - Tracking SCOPE-LEVEL uniquement (dans la même fonction).
 *   - Pas de re-assignment tracking (`x = ...; x = req.body...`).
 *   - Pas de propagation à travers d'autres calls (limite du nom var).
 *   - Pas de sanitizer detection inline (`const id = parseInt(req.body.id)`).
 *
 * V2 (Tier 15) — destructuring patterns supportés :
 *   - `const { id, name } = req.body` → `id`, `name` taintés (idiomatique Express)
 *   - `const { id: userId } = req.body` → `userId` tainté (alias)
 *   - `const [first] = req.params` → `first` tainté
 *   - Nested destructuring (`const { a: { b } } = req.body`) → V3
 *
 * Sources reconnues : `req.body`, `req.query`, `req.params`, `req.headers`,
 * `request.body`, `ctx.req.body`, `process.argv`, `process.env`.
 */

import { type Project, type SourceFile, Node, SyntaxKind } from 'ts-morph'

export type TaintSourceKind =
  | 'req.body'
  | 'req.query'
  | 'req.params'
  | 'req.headers'
  | 'process.argv'
  | 'process.env'

export interface TaintedVarDecl {
  file: string
  /** Symbole englobant (function/method) où la var est déclarée. */
  containingSymbol: string
  /** Nom de la variable. */
  varName: string
  line: number
  source: TaintSourceKind
}

export interface TaintedArgCall {
  file: string
  line: number
  /** Le callee (ex: "db.query", "eval"). */
  callee: string
  /** Nom de la variable taintée passée en argument. */
  argVarName: string
  /** Position 0-based de l'argument dans le call. */
  argIndex: number
  /** Source kind héritée de la déclaration de varName. */
  source: TaintSourceKind
  containingSymbol: string
}

export interface TaintedVarsFileBundle {
  decls: TaintedVarDecl[]
  argCalls: TaintedArgCall[]
}

const TEST_FILE_RE = /(\.test\.tsx?|\.spec\.tsx?|(^|\/)tests?\/|(^|\/)fixtures?\/)/

/**
 * Patterns d'expression qui matchent un user input non-sanitizé.
 * Le matcher est sur le DEBUT de l'expression (PropertyAccessExpression
 * en chaîne).
 */
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

export function extractTaintedVarsFileBundle(
  sf: SourceFile,
  relPath: string,
): TaintedVarsFileBundle {
  if (TEST_FILE_RE.test(relPath)) return { decls: [], argCalls: [] }
  const decls: TaintedVarDecl[] = []
  const argCalls: TaintedArgCall[] = []

  // ─── Pass 1 : collecter les VariableDeclaration tainted ─────────────
  // Pour chaque function scope, build un Map<varName, source>.
  const taintedByFn = new Map<string, Map<string, TaintSourceKind>>()

  const collectInScope = (
    fnNode: Node,
    fnId: string,
    fnName: string,
  ): void => {
    const taintedVars = new Map<string, TaintSourceKind>()
    for (const v of fnNode.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const init = v.getInitializer()
      if (!init) continue
      const text = init.getText()
      const source = matchSource(text)
      if (!source) continue
      const nameNode = v.getNameNode()
      const line = v.getStartLineNumber()
      if (Node.isIdentifier(nameNode)) {
        const varName = nameNode.getText()
        taintedVars.set(varName, source)
        decls.push({ file: relPath, containingSymbol: fnName, varName, line, source })
      } else if (
        Node.isObjectBindingPattern(nameNode) ||
        Node.isArrayBindingPattern(nameNode)
      ) {
        // V2 (Tier 15) : `const { id, name } = req.body` ou `const [a] = req.params`.
        // Chaque BindingElement devient une tainted var. Alias supporté
        // (`{ id: userId }` → `userId`). Nested destructuring skip V1.
        for (const elem of nameNode.getElements()) {
          if (!Node.isBindingElement(elem)) continue
          const elemName = elem.getNameNode()
          if (!Node.isIdentifier(elemName)) continue
          const varName = elemName.getText()
          taintedVars.set(varName, source)
          decls.push({ file: relPath, containingSymbol: fnName, varName, line, source })
        }
      }
    }
    if (taintedVars.size > 0) {
      taintedByFn.set(fnId, taintedVars)
    }
  }

  // Function-like nodes à inspecter.
  for (const fn of sf.getFunctions()) {
    const name = fn.getName() ?? '(anonymous)'
    collectInScope(fn, `fn:${name}:${fn.getStartLineNumber()}`, name)
  }
  for (const cls of sf.getClasses()) {
    const className = cls.getName() ?? '(anonymous)'
    for (const method of cls.getMethods()) {
      const name = `${className}.${method.getName()}`
      collectInScope(method, `mth:${name}:${method.getStartLineNumber()}`, name)
    }
  }
  for (const v of sf.getVariableDeclarations()) {
    const init = v.getInitializer()
    if (!init) continue
    if (!Node.isArrowFunction(init) && !Node.isFunctionExpression(init)) continue
    const name = v.getName()
    collectInScope(init, `arrow:${name}:${v.getStartLineNumber()}`, name)
  }

  // ─── Pass 2 : trouver les call-sites qui passent ces vars en arg ──
  // On re-traverse les fonctions et pour chaque CallExpression interne,
  // on check chaque argument identifier contre la map des tainted vars.
  const checkCallsInScope = (
    fnNode: Node,
    fnId: string,
    fnName: string,
  ): void => {
    const taintedVars = taintedByFn.get(fnId)
    if (!taintedVars) return
    for (const call of fnNode.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression()
      let calleeText: string
      if (Node.isIdentifier(callee)) calleeText = callee.getText()
      else if (Node.isPropertyAccessExpression(callee)) calleeText = callee.getText()
      else continue

      const args = call.getArguments()
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (!Node.isIdentifier(arg)) continue
        const varName = arg.getText()
        const source = taintedVars.get(varName)
        if (!source) continue
        argCalls.push({
          file: relPath,
          line: call.getStartLineNumber(),
          callee: calleeText,
          argVarName: varName,
          argIndex: i,
          source,
          containingSymbol: fnName,
        })
      }
      // Aussi : check les arguments qui sont des PropertyAccess sur tainted
      // var (ex: `db.query(userId.toString())` → userId est tainted).
      // V1 skip : trop de faux-positifs sans dataflow propre.
    }
  }

  for (const fn of sf.getFunctions()) {
    const name = fn.getName() ?? '(anonymous)'
    checkCallsInScope(fn, `fn:${name}:${fn.getStartLineNumber()}`, name)
  }
  for (const cls of sf.getClasses()) {
    const className = cls.getName() ?? '(anonymous)'
    for (const method of cls.getMethods()) {
      const name = `${className}.${method.getName()}`
      checkCallsInScope(method, `mth:${name}:${method.getStartLineNumber()}`, name)
    }
  }
  for (const v of sf.getVariableDeclarations()) {
    const init = v.getInitializer()
    if (!init) continue
    if (!Node.isArrowFunction(init) && !Node.isFunctionExpression(init)) continue
    const name = v.getName()
    checkCallsInScope(init, `arrow:${name}:${v.getStartLineNumber()}`, name)
  }

  return { decls, argCalls }
}

export async function analyzeTaintedVars(
  rootDir: string,
  files: string[],
  project: Project,
): Promise<{ decls: TaintedVarDecl[]; argCalls: TaintedArgCall[] }> {
  const fileSet = new Set(files)
  const allDecls: TaintedVarDecl[] = []
  const allArgCalls: TaintedArgCall[] = []

  for (const sf of project.getSourceFiles()) {
    const rel = relativize(sf.getFilePath(), rootDir)
    if (!rel || !fileSet.has(rel)) continue
    const bundle = extractTaintedVarsFileBundle(sf, rel)
    allDecls.push(...bundle.decls)
    allArgCalls.push(...bundle.argCalls)
  }

  allDecls.sort((a, b) =>
    a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.line - b.line,
  )
  allArgCalls.sort((a, b) =>
    a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.line - b.line,
  )

  return { decls: allDecls, argCalls: allArgCalls }
}

function relativize(absPath: string, rootDir: string): string | null {
  const normalized = absPath.replace(/\\/g, '/')
  const rootNormalized = rootDir.replace(/\\/g, '/')
  if (!normalized.startsWith(rootNormalized)) return null
  return normalized.slice(rootNormalized.length + 1)
}
