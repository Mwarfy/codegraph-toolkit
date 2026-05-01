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
import { findContainingSymbol } from './_shared/ast-helpers.js'

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

  const lines = sf.getFullText().split('\n')
  const isExempt = (line: number): boolean => {
    if (line < 2 || line - 2 >= lines.length) return false
    const prev = lines[line - 2]
    return /\/\/\s*fire-and-forget\b/.test(prev)
  }

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
  // Remonte les wrappers neutres : ParenthesizedExpression, AsExpression,
  // TypeAssertionExpression, NonNullExpression.
  while (true) {
    const parent = cursor.getParent()
    if (!parent) return false
    if (
      Node.isParenthesizedExpression(parent) ||
      Node.isAsExpression(parent) ||
      Node.isTypeAssertion(parent) ||
      Node.isNonNullExpression(parent)
    ) {
      cursor = parent
      continue
    }
    // Patterns de consommation acceptés.
    if (Node.isAwaitExpression(parent)) return true
    if (Node.isVoidExpression(parent)) return true
    if (Node.isReturnStatement(parent)) return true
    if (Node.isYieldExpression(parent)) return true
    if (Node.isVariableDeclaration(parent)) return true
    if (Node.isPropertyAssignment(parent)) return true
    if (Node.isArrowFunction(parent)) return true   // `() => foo()` arrow concise body
    if (Node.isBinaryExpression(parent)) {
      const op = parent.getOperatorToken().getText()
      if (op === '=' || op === '||' || op === '&&' || op === '??') return true
    }
    if (Node.isPropertyAccessExpression(parent)) {
      // foo().then / .catch / .finally — chainé.
      const propName = parent.getName()
      if (propName === 'then' || propName === 'catch' || propName === 'finally') return true
      // Autre property access (`foo().bar`) — considéré consommé aussi.
      return true
    }
    if (Node.isCallExpression(parent)) {
      // foo() est passé en argument à une autre fonction → consommé.
      // Sauf si foo() EST la callee elle-même (cas rare).
      return parent.getExpression() !== cursor
    }
    if (Node.isArrayLiteralExpression(parent)) return true   // [foo(), bar()]
    if (Node.isObjectLiteralExpression(parent)) return true
    if (Node.isSpreadElement(parent)) return true
    if (Node.isConditionalExpression(parent)) return true    // `cond ? foo() : bar()`
    return false
  }
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
