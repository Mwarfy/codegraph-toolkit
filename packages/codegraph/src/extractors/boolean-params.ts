/**
 * Boolean positional parameters — détecteur déterministe AST.
 *
 * Capture les fonctions qui prennent un boolean comme param positionnel
 * (sans named arg / object destructuring). Au call site, ça devient
 * `foo(true)` ou `foo(x, false)` — illisible sans aller lire la
 * signature.
 *
 * Pattern reconnu OK (skip) :
 *   - Setters/getters : `setEnabled(b)`, `isFoo(b)` → un seul param boolean
 *     est explicite par le nom de la fonction.
 *   - Callbacks : params boolean dans `(err, ok, data) => ...` typique.
 *   - Le boolean est dans une option object : `foo({ enabled: true })`.
 *   - 1 seul param boolean dans une fonction à 1 seul param.
 *
 * Pattern flaggé :
 *   - >= 2 params dont au moins 1 boolean positionnel non-name-marker.
 *   - OU 1 param boolean dans une fonction qui n'est PAS un setter/predicate.
 *
 * Inspiration : Checkstyle Java, Sonar `S2301` (pass boolean param).
 *
 * Convention exempt : `// boolean-ok: <reason>` sur la ligne précédente.
 */

import { type Project, type SourceFile, Node, SyntaxKind } from 'ts-morph'

export interface BooleanParamSite {
  file: string
  /** Nom du symbole (function/method/arrow). */
  name: string
  /** Ligne de la déclaration. */
  line: number
  /** Position 0-based du param boolean. */
  paramIndex: number
  /** Nom du param boolean. */
  paramName: string
  /** Total de params (utile pour évaluer la confusion possible). */
  totalParams: number
}

export interface BooleanParamsFileBundle {
  sites: BooleanParamSite[]
}

const SETTER_PREDICATE_RE = /^(set|is|has|can|should|enable|disable|toggle)/i

/**
 * Skip pour les fichiers de test — les fixtures et helpers utilisent
 * souvent des params boolean (mocks, callbacks).
 */
const TEST_FILE_RE = /(\.test\.tsx?|\.spec\.tsx?|(^|\/)tests?\/|(^|\/)fixtures?\/)/

export function extractBooleanParamsFileBundle(
  sf: SourceFile,
  relPath: string,
): BooleanParamsFileBundle {
  if (TEST_FILE_RE.test(relPath)) return { sites: [] }
  const sites: BooleanParamSite[] = []

  const lines = sf.getFullText().split('\n')
  const isExempt = (line: number): boolean => {
    if (line < 2 || line - 2 >= lines.length) return false
    const prev = lines[line - 2]
    return /\/\/\s*boolean-ok\b/.test(prev)
  }

  const checkFn = (
    name: string,
    params: ReadonlyArray<{ getName(): string; getType(): { getText(): string }; getTypeNode(): Node | undefined }>,
    line: number,
  ): void => {
    if (isExempt(line)) return
    if (params.length === 0) return
    // Skip setters / predicates avec 1 param boolean — pattern explicite.
    if (params.length === 1 && SETTER_PREDICATE_RE.test(name)) return

    for (let i = 0; i < params.length; i++) {
      const p = params[i]
      const typeText = (p.getTypeNode()?.getText() ?? p.getType().getText()).trim()
      // Match `boolean` ou `bool` exact. Skip `boolean | undefined` ou
      // unions élargies — souvent un flag optionnel intentionnel.
      if (typeText !== 'boolean' && typeText !== 'bool') continue
      sites.push({
        file: relPath,
        name,
        line,
        paramIndex: i,
        paramName: p.getName(),
        totalParams: params.length,
      })
    }
  }

  for (const fn of sf.getFunctions()) {
    checkFn(fn.getName() ?? '(anonymous)', fn.getParameters() as any, fn.getStartLineNumber())
  }
  for (const cls of sf.getClasses()) {
    const className = cls.getName() ?? '(anonymous)'
    for (const method of cls.getMethods()) {
      checkFn(`${className}.${method.getName()}`, method.getParameters() as any, method.getStartLineNumber())
    }
  }
  for (const v of sf.getVariableDeclarations()) {
    const init = v.getInitializer()
    if (!init) continue
    if (!Node.isArrowFunction(init) && !Node.isFunctionExpression(init)) continue
    checkFn(v.getName(), init.getParameters() as any, v.getStartLineNumber())
  }

  return { sites }
}

export async function analyzeBooleanParams(
  rootDir: string,
  files: string[],
  project: Project,
): Promise<BooleanParamSite[]> {
  const fileSet = new Set(files)
  const all: BooleanParamSite[] = []

  for (const sf of project.getSourceFiles()) {
    const rel = relativize(sf.getFilePath(), rootDir)
    if (!rel || !fileSet.has(rel)) continue
    const bundle = extractBooleanParamsFileBundle(sf, rel)
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
