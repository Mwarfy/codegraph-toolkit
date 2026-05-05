import { type SourceFile, Node } from 'ts-morph'
import type { FunctionScopeFact, FunctionParamFact } from './types.js'

const SETTER_PREDICATE_RE = /^(set|is|has|can|should|enable|disable|toggle)/i

function pushScopeAndParams(
  file: string,
  line: number,
  name: string,
  params: Array<{ name: string; typeText: string }>,
  scopesOut: FunctionScopeFact[],
  paramsOut: FunctionParamFact[],
): void {
  scopesOut.push({
    file, line, name,
    totalParams: params.length,
    nameMatchesSetterPredicate: SETTER_PREDICATE_RE.test(name) ? 1 : 0,
  })
  for (let i = 0; i < params.length; i++) {
    const p = params[i]
    paramsOut.push({
      file, scopeLine: line, paramIndex: i,
      paramName: p.name, typeText: p.typeText,
    })
  }
}

export function visitFunctionScopesAndParams(
  sf: SourceFile,
  relPath: string,
  scopesOut: FunctionScopeFact[],
  paramsOut: FunctionParamFact[],
): void {
  for (const fn of sf.getFunctions()) {
    const name = fn.getName() ?? '(anonymous)'
    pushScopeAndParams(relPath, fn.getStartLineNumber(), name,
      fn.getParameters().map((p) => ({
        name: p.getName(),
        typeText: (p.getTypeNode()?.getText() ?? p.getType().getText()).trim(),
      })),
      scopesOut, paramsOut)
  }
  for (const cls of sf.getClasses()) {
    const className = cls.getName() ?? '(anonymous)'
    for (const m of cls.getMethods()) {
      const fullName = `${className}.${m.getName()}`
      pushScopeAndParams(relPath, m.getStartLineNumber(), fullName,
        m.getParameters().map((p) => ({
          name: p.getName(),
          typeText: (p.getTypeNode()?.getText() ?? p.getType().getText()).trim(),
        })),
        scopesOut, paramsOut)
    }
  }
  for (const v of sf.getVariableDeclarations()) {
    const init = v.getInitializer()
    if (!init) continue
    if (!Node.isArrowFunction(init) && !Node.isFunctionExpression(init)) continue
    pushScopeAndParams(relPath, v.getStartLineNumber(), v.getName(),
      init.getParameters().map((p) => ({
        name: p.getName(),
        typeText: (p.getTypeNode()?.getText() ?? p.getType().getText()).trim(),
      })),
      scopesOut, paramsOut)
  }
}
