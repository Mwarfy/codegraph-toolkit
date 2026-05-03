/**
 * Floating promises — détecteur déterministe AST (Phase 4 Tier 4).
 *
 * Capture les call-sites qui INVOQUENT une fonction async (retournant
 * Promise) sans `await`, sans `.then`, sans `.catch`, et sans assigner
 * le résultat à une variable / le retourner. Ces "promises orphelines"
 * peuvent rejeter en silence — un `await` oublié = job qui finish "en
 * succès" alors que la promise rejette en arrière-plan.
 *
 * Inspiration : rustc `unused_must_use`, ESLint `no-floating-promises`
 * (qui demande typecheck profond — on fait pareil mais AST + indication
 * via typedCalls.signatures qu'on a déjà émis).
 *
 * Stratégie déterministe :
 *   1. Build un set des symbols (file:name) dont le returnType est
 *      "Promise<...>" (depuis snapshot.typedCalls.signatures déjà émis).
 *   2. Scanner toutes les CallExpressions du fichier. Pour chaque, si
 *      l'expression callée matche un symbol async connu (best-effort
 *      sur le nom seul), check si le call est :
 *      - awaité (`await foo()`)
 *      - chainé (`foo().then(...)` / `.catch(...)` / `.finally(...)`)
 *      - assigné (`const x = foo()`)
 *      - retourné (`return foo()`)
 *      - dans une expression-list `void foo()` (annotation explicite)
 *      Si AUCUN de ces patterns → flagger.
 *
 * Convention exempt : `// fire-and-forget: <reason>` ligne précédente.
 *
 * Skip fichiers test (mocks/fixtures async chainés).
 */

import { type Project, type SourceFile, Node, SyntaxKind } from 'ts-morph'
import { findContainingSymbol, makeIsExemptForMarker } from './_shared/ast-helpers.js'

export interface FloatingPromiseSite {
  file: string
  line: number
  /** Le nom de la fonction async appelée (juste le method name, pas qualifié). */
  callee: string
  /** Le symbole englobant (function/method) qui contient ce call. */
  containingSymbol: string
}

export interface FloatingPromisesFileBundle {
  sites: FloatingPromiseSite[]
}

const TEST_FILE_RE = /(\.test\.tsx?|\.spec\.tsx?|(^|\/)tests?\/|(^|\/)fixtures?\/)/

// Noms de callbacks conventionnels qui apparaissent souvent dans les
// signatures (ex: param `resolve` d'un Promise constructor) MAIS qui ne
// sont jamais des "vraies" fonctions async exportées qu'on doit awaiter.
// Skip systématique pour éviter les faux-positifs.
const CALLBACK_NAME_DENYLIST = new Set([
  'resolve', 'reject', 'done', 'next', 'cb', 'callback',
  'fail', 'success', 'pass',
])

export function extractFloatingPromisesFileBundle(
  sf: SourceFile,
  relPath: string,
  asyncSymbolNames: Set<string>,
): FloatingPromisesFileBundle {
  if (TEST_FILE_RE.test(relPath)) return { sites: [] }
  const sites: FloatingPromiseSite[] = []

  const isExempt = makeIsExemptForMarker(sf, 'fire-and-forget')

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    // Identifier le nom de la fonction appelée. Cas typiques :
    //   foo()         → Identifier "foo"
    //   obj.foo()     → PropertyAccess "foo"
    //   obj?.foo()    → PropertyAccess "foo"
    const callee = call.getExpression()
    let calleeName: string | null = null
    if (Node.isIdentifier(callee)) calleeName = callee.getText()
    else if (Node.isPropertyAccessExpression(callee)) calleeName = callee.getName()
    if (!calleeName) continue
    if (!asyncSymbolNames.has(calleeName)) continue

    // Check si le call est consommé proprement.
    if (isAwaitedOrConsumed(call)) continue

    const line = call.getStartLineNumber()
    if (isExempt(line)) continue

    sites.push({
      file: relPath,
      line,
      callee: calleeName,
      containingSymbol: findContainingSymbol(call),
    })
  }

  return { sites }
}

/**
 * Détermine si un CallExpression est consommé : awaité, chainé,
 * assigné, retourné, ou marqué `void`. On REMONTE à travers les wrappers
 * neutres (parens, type assertions, `as`) pour ne pas être trompé par
 * `await (foo() as Promise<X>)`.
 */
function isAwaitedOrConsumed(call: Node): boolean {
  let cursor: Node = call
  while (true) {
    const parent = cursor.getParent()
    if (!parent) return false
    if (isNeutralWrapper(parent)) {
      cursor = parent
      continue
    }
    return isConsumingParent(parent, cursor)
  }
}

/** ParenthesizedExpression, AsExpression, TypeAssertion, NonNullExpression. */
function isNeutralWrapper(parent: Node): boolean {
  return Node.isParenthesizedExpression(parent)
    || Node.isAsExpression(parent)
    || Node.isTypeAssertion(parent)
    || Node.isNonNullExpression(parent)
}

/** Tous les patterns acceptés comme "consomme la promesse". */
function isConsumingParent(parent: Node, cursor: Node): boolean {
  if (isReturnLikeContext(parent)) return true
  if (isAssignmentLikeContext(parent)) return true
  if (isContainerContext(parent)) return true
  if (Node.isBinaryExpression(parent)) return isAssignOrShortCircuit(parent)
  if (Node.isPropertyAccessExpression(parent)) return true   // .then/.catch/.finally OU autre prop access
  if (Node.isCallExpression(parent)) return parent.getExpression() !== cursor
  return false
}

/** await / void / return / yield / arrow concise body. */
function isReturnLikeContext(parent: Node): boolean {
  return Node.isAwaitExpression(parent)
    || Node.isVoidExpression(parent)
    || Node.isReturnStatement(parent)
    || Node.isYieldExpression(parent)
    || Node.isArrowFunction(parent)
}

/** const x = foo() / { x: foo() }. */
function isAssignmentLikeContext(parent: Node): boolean {
  return Node.isVariableDeclaration(parent)
    || Node.isPropertyAssignment(parent)
}

/** [foo(), bar()] / { foo() } via shorthand / ...foo() / cond ? foo() : bar(). */
function isContainerContext(parent: Node): boolean {
  return Node.isArrayLiteralExpression(parent)
    || Node.isObjectLiteralExpression(parent)
    || Node.isSpreadElement(parent)
    || Node.isConditionalExpression(parent)
}

/** = pour assign ; || && ?? pour fallback chain (la valeur est utilisée). */
function isAssignOrShortCircuit(parent: import('ts-morph').BinaryExpression): boolean {
  const op = parent.getOperatorToken().getText()
  return op === '=' || op === '||' || op === '&&' || op === '??'
}

/**
 * Aggregator : tous les call-sites floating du projet.
 * `asyncSymbolNames` = set construit depuis snapshot.typedCalls.signatures
 * (toutes les signatures dont returnType matche /Promise</).
 */
export async function analyzeFloatingPromises(
  rootDir: string,
  files: string[],
  project: Project,
  typedCalls: { signatures: Array<{ exportName: string; returnType: string }> } | undefined,
): Promise<FloatingPromiseSite[]> {
  const fileSet = new Set(files)
  const all: FloatingPromiseSite[] = []

  // Build le set des symbols qui retournent une Promise. Best-effort :
  // on indexe par exportName seul (pas par file:name), donc collisions
  // possibles si plusieurs symbols partagent le même nom. Pour V1 c'est
  // un trade-off acceptable — les false-positives sont gérables via
  // `// fire-and-forget` exemption.
  const asyncSymbolNames = new Set<string>()
  if (typedCalls) {
    for (const sig of typedCalls.signatures) {
      if (!/^Promise</.test(sig.returnType.trim())) continue
      const name = sig.exportName
      // Skip les noms callback conventionnels — vrais faux-positifs
      // (le nom `resolve` matche le param d'un Promise constructor,
      // pas une fonction qu'on doit awaiter).
      if (CALLBACK_NAME_DENYLIST.has(name)) continue
      // Skip les noms suffixés `.method` issus de class methods —
      // pour V1 on ne match que sur le method name seul. Pour les
      // class methods exportées on accepte (Foo.bar → name = 'Foo.bar',
      // on ajoute 'bar' aussi pour le call-site `obj.bar()`).
      asyncSymbolNames.add(name)
      const methodMatch = name.match(/\.([A-Za-z_][\w$]*)$/)
      if (methodMatch && !CALLBACK_NAME_DENYLIST.has(methodMatch[1])) {
        asyncSymbolNames.add(methodMatch[1])
      }
    }
  }

  // Pas de signatures = on ne peut rien détecter de fiable. Retourne vide.
  if (asyncSymbolNames.size === 0) return all

  for (const sf of project.getSourceFiles()) {
    const rel = relativize(sf.getFilePath(), rootDir)
    if (!rel || !fileSet.has(rel)) continue
    const bundle = extractFloatingPromisesFileBundle(sf, rel, asyncSymbolNames)
    all.push(...bundle.sites)
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
