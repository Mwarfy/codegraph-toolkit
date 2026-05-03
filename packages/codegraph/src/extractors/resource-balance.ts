/**
 * Resource Balance — détecteur déterministe AST (Phase 4 Tier 6).
 *
 * Capture les fonctions où un appel à `acquire`-style n'est pas
 * équilibré par un appel à `release`-style dans le MÊME scope. Pattern
 * classique de leak de ressource.
 *
 * Inspiration : Reed-Solomon style "parité de symboles" — pour chaque
 * acquire il doit y avoir un release. Si N acquire et M release dans
 * un même scope avec N != M, suspect.
 *
 * Pairs reconnus (configurable) :
 *   - acquire / release
 *   - lock / unlock
 *   - connect / disconnect
 *   - open / close
 *   - subscribe / unsubscribe
 *   - setInterval / clearInterval
 *   - setTimeout / clearTimeout (V1: ignoré car souvent intentionnel)
 *   - addEventListener / removeEventListener
 *
 * Stratégie déterministe :
 *   1. Pour chaque fonction (def, method, arrow), scanner les call
 *      expressions internes.
 *   2. Compter les calls qui matchent acquire vs release pour chaque
 *      pair.
 *   3. Si counts différents → finding (`acquire-release-imbalance`).
 *
 * Limites V1 :
 *   - Ne suit pas les flows cross-fonction (un acquire passé à une
 *     autre fonction qui release n'est pas tracé).
 *   - Ne reconnaît pas le pattern try/finally cleanup automatique.
 *   - Skip les fichiers de test.
 *   - Convention exempt : `// resource-balance-ok: <reason>` ligne
 *     précédente.
 */

import { type Project, type SourceFile, Node, SyntaxKind } from 'ts-morph'
import { makeIsExemptForMarker } from './_shared/ast-helpers.js'

export interface ResourceImbalance {
  file: string
  /** Nom de la fonction qui contient l'imbalance. */
  containingSymbol: string
  /** Ligne de la fonction. */
  line: number
  /** Pair concerné, ex: "acquire/release". */
  pair: string
  acquireCount: number
  releaseCount: number
}

export interface ResourceBalanceFileBundle {
  imbalances: ResourceImbalance[]
}

const TEST_FILE_RE = /(\.test\.tsx?|\.spec\.tsx?|(^|\/)tests?\/|(^|\/)fixtures?\/)/

interface PairDef {
  acquire: string
  release: string
}

const PAIRS: PairDef[] = [
  { acquire: 'acquire', release: 'release' },
  { acquire: 'lock', release: 'unlock' },
  { acquire: 'connect', release: 'disconnect' },
  { acquire: 'open', release: 'close' },
  { acquire: 'subscribe', release: 'unsubscribe' },
  { acquire: 'setInterval', release: 'clearInterval' },
  { acquire: 'addEventListener', release: 'removeEventListener' },
]

export function extractResourceBalanceFileBundle(
  sf: SourceFile,
  relPath: string,
): ResourceBalanceFileBundle {
  if (TEST_FILE_RE.test(relPath)) return { imbalances: [] }
  const imbalances: ResourceImbalance[] = []

  const isExempt = makeIsExemptForMarker(sf, 'resource-balance-ok')

  const checkFn = (
    name: string,
    body: Node | undefined,
    line: number,
  ): void => {
    if (!body || isExempt(line)) return
    // Compter les calls par méthode name.
    const counts = new Map<string, number>()
    for (const call of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression()
      let methodName: string | null = null
      if (Node.isIdentifier(callee)) methodName = callee.getText()
      else if (Node.isPropertyAccessExpression(callee)) methodName = callee.getName()
      if (!methodName) continue
      counts.set(methodName, (counts.get(methodName) ?? 0) + 1)
    }
    // Pour chaque pair, comparer les counts.
    // Skip les pure-acquire / pure-release functions (= pattern split
    // start/stop typique). On ne flag que si LES DEUX existent dans la
    // même fonction avec counts différents — vrai signal de leak intra-
    // function.
    for (const pair of PAIRS) {
      const acq = counts.get(pair.acquire) ?? 0
      const rel = counts.get(pair.release) ?? 0
      if (acq === 0 || rel === 0) continue   // pure-X = start/stop split
      if (acq !== rel) {
        imbalances.push({
          file: relPath,
          containingSymbol: name,
          line,
          pair: `${pair.acquire}/${pair.release}`,
          acquireCount: acq,
          releaseCount: rel,
        })
      }
    }
  }

  for (const fn of sf.getFunctions()) {
    checkFn(fn.getName() ?? '(anonymous)', fn.getBody(), fn.getStartLineNumber())
  }
  for (const cls of sf.getClasses()) {
    const className = cls.getName() ?? '(anonymous)'
    for (const method of cls.getMethods()) {
      checkFn(`${className}.${method.getName()}`, method.getBody(), method.getStartLineNumber())
    }
  }
  for (const v of sf.getVariableDeclarations()) {
    const init = v.getInitializer()
    if (!init) continue
    if (!Node.isArrowFunction(init) && !Node.isFunctionExpression(init)) continue
    checkFn(v.getName(), init.getBody(), v.getStartLineNumber())
  }

  return { imbalances }
}

export async function analyzeResourceBalance(
  rootDir: string,
  files: string[],
  project: Project,
): Promise<ResourceImbalance[]> {
  const fileSet = new Set(files)
  const all: ResourceImbalance[] = []

  for (const sf of project.getSourceFiles()) {
    const rel = relativize(sf.getFilePath(), rootDir)
    if (!rel || !fileSet.has(rel)) continue
    const bundle = extractResourceBalanceFileBundle(sf, rel)
    all.push(...bundle.imbalances)
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
