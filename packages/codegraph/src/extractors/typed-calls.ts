/**
 * Typed Calls Extractor — structural map phase 1.2
 *
 * Pour chaque fichier, remplace "importe X" par "appelle X avec tel type,
 * reçoit tel type". Deux productions par fichier :
 *
 *   1. `TypedSignature` — pour chaque export callable (function / class /
 *      method / const de type fonction), la signature typée : params + type
 *      de retour + kind + ligne.
 *   2. `TypedCallEdge` — pour chaque call site qui résout à un export connu,
 *      un edge typé : types des arguments + type consommé.
 *
 * Résolution (v1, syntaxique) :
 *   - Call `foo(a, b)` où `foo` est un named import → edge vers target:originalName.
 *   - Call `ns.foo(a, b)` où `ns` est un namespace import → edge vers target:foo.
 *   - New `ClassName(a, b)` où `ClassName` est un named import → edge vers target:ClassName.
 *   - Méthodes sur instances d'une classe (`obj.method()`) : NON résolues v1.
 *     Le plan l'assume (faux négatif accepté) — ts-morph TypeChecker serait
 *     requis pour tracer `obj`'s type jusqu'à la déclaration et plomberait la
 *     perf sur gros projets.
 *
 * Les call edges pointant vers un symbole non-tracké (export non vu dans
 * `files`, appel à une lib externe, méthode d'instance) sont OMIS — jamais
 * d'affirmation floue, seulement ce qu'on peut prouver au niveau AST+imports.
 */

import { Project, Node, SyntaxKind, type SourceFile, type CallExpression, type NewExpression } from 'ts-morph'
import * as path from 'node:path'
import type { TypedCalls, TypedSignature, TypedCallEdge } from '../core/types.js'

interface ImportMaps {
  named: Map<string, { file: string; originalName: string }>
  namespace: Map<string, string>
}

/**
 * Analyse l'ensemble du projet et retourne signatures + call edges.
 * Réutilise le ts-morph Project partagé (analyzer.ts).
 * Seuls les fichiers listés dans `files` sont considérés en source, et
 * seuls les edges dont le target appartient à `files` sont émis.
 */
export async function analyzeTypedCalls(
  rootDir: string,
  files: string[],
  project: Project,
): Promise<TypedCalls> {
  const fileSet = new Set(files)

  // ─── Per-file extraction (Salsa-isable) ─────────────────────────────
  const bundles = new Map<string, TypedCallsFileBundle>()
  for (const sf of project.getSourceFiles()) {
    const relPath = relativize(sf.getFilePath(), rootDir)
    if (!relPath || !fileSet.has(relPath)) continue
    bundles.set(relPath, extractTypedCallsFileBundle(sf, relPath, rootDir))
  }

  return aggregateTypedCalls(bundles)
}

/**
 * Bundle per-file : signatures déclarées + raw call edges (avant
 * filtre par knownExports global). L'agrégat filtre.
 */
export interface TypedCallsFileBundle {
  signatures: TypedSignature[]
  rawCallEdges: TypedCallEdge[]
}

/**
 * Helper réutilisable : extrait les signatures + raw call edges d'UN
 * SourceFile. Le filter global par `knownExports` est fait au niveau
 * de l'agrégateur (ne dépend pas que de ce fichier).
 */
export function extractTypedCallsFileBundle(
  sf: SourceFile,
  relPath: string,
  rootDir: string,
): TypedCallsFileBundle {
  const signatures = extractSignatures(sf, relPath)

  const rawCallEdges: TypedCallEdge[] = []
  const maps = getImportMap(sf, rootDir)
  if (maps.named.size === 0 && maps.namespace.size === 0) {
    return { signatures, rawCallEdges }
  }

  for (const unit of getCallableUnits(sf)) {
    const fromKey = `${relPath}:${unit.name}`
    visitCalls(unit.body, (callExpr) => {
      const resolved = resolveCallee(callExpr, maps)
      if (!resolved) return
      const toKey = `${resolved.file}:${resolved.name}`
      const line = callExpr.getStartLineNumber()
      const argTypes = extractArgTypes(callExpr)
      const returnType = extractReturnType(callExpr)
      rawCallEdges.push({ from: fromKey, to: toKey, argTypes, returnType, line })
    })
  }

  return { signatures, rawCallEdges }
}

/**
 * Agrège les bundles per-file en `TypedCalls` final : construit
 * knownExports, filtre les rawCallEdges, dédup, sort.
 */
export function aggregateTypedCalls(
  bundles: Map<string, TypedCallsFileBundle>,
): TypedCalls {
  const signatures: TypedSignature[] = []
  const knownExports = new Set<string>()

  for (const bundle of bundles.values()) {
    for (const sig of bundle.signatures) {
      signatures.push(sig)
      knownExports.add(`${sig.file}:${sig.exportName}`)
    }
  }

  const callEdges: TypedCallEdge[] = []
  const edgeDedup = new Set<string>()

  for (const bundle of bundles.values()) {
    for (const edge of bundle.rawCallEdges) {
      if (!knownExports.has(edge.to)) continue
      const dedupKey = `${edge.from}->${edge.to}@${edge.line}`
      if (edgeDedup.has(dedupKey)) continue
      edgeDedup.add(dedupKey)
      callEdges.push(edge)
    }
  }

  signatures.sort(compareSignatures)
  callEdges.sort(compareCallEdges)

  return { signatures, callEdges }
}

// ─── Signatures ──────────────────────────────────────────────────────────────

function extractSignatures(sf: SourceFile, file: string): TypedSignature[] {
  const out: TypedSignature[] = []

  // FunctionDeclaration exportée — `export function foo(...)`
  for (const fd of sf.getFunctions()) {
    if (!fd.isExported()) continue
    const name = fd.getName()
    if (!name) continue
    out.push({
      file,
      exportName: name,
      kind: 'function',
      params: fd.getParameters().map(toParamEntry),
      returnType: safeTypeText(fd.getReturnType(), fd),
      line: fd.getStartLineNumber(),
    })
  }

  // ClassDeclaration exportée + méthodes
  for (const cd of sf.getClasses()) {
    if (!cd.isExported()) continue
    const className = cd.getName()
    if (!className) continue

    // Signature de la classe (params du constructor, returnType = ClassName)
    const ctor = cd.getConstructors()[0]
    out.push({
      file,
      exportName: className,
      kind: 'class',
      params: ctor ? ctor.getParameters().map(toParamEntry) : [],
      returnType: className,
      line: cd.getStartLineNumber(),
    })

    // Méthodes publiques — pour le graphe on n'inclut que les méthodes non-privées
    // (le # et le modifier `private` cachent l'API).
    for (const method of cd.getMethods()) {
      if (method.hasModifier(SyntaxKind.PrivateKeyword)) continue
      if (method.getName().startsWith('#')) continue
      out.push({
        file,
        exportName: `${className}.${method.getName()}`,
        kind: 'method',
        params: method.getParameters().map(toParamEntry),
        returnType: safeTypeText(method.getReturnType(), method),
        line: method.getStartLineNumber(),
      })
    }
  }

  // const exportée de type fonction — `export const foo = () => ...`
  for (const vs of sf.getVariableStatements()) {
    if (!vs.isExported()) continue
    for (const vd of vs.getDeclarations()) {
      const init = vd.getInitializer()
      if (!init) continue
      const initKind = init.getKind()
      if (initKind !== SyntaxKind.ArrowFunction && initKind !== SyntaxKind.FunctionExpression) continue

      // Les deux kinds ont getParameters() + getReturnType() au runtime ts-morph.
      const fn = init as any
      out.push({
        file,
        exportName: vd.getName(),
        kind: 'const',
        params: (fn.getParameters?.() ?? []).map(toParamEntry),
        returnType: safeTypeText(fn.getReturnType?.(), vd),
        line: vd.getStartLineNumber(),
      })
    }
  }

  return out
}

function toParamEntry(p: any): { name: string; type: string; optional: boolean } {
  return {
    name: p.getName?.() ?? '<anonymous>',
    type: safeTypeText(p.getType?.(), p),
    optional: p.isOptional?.() ?? false,
  }
}

/**
 * `getText(enclosingNode)` produit un texte de type scopé (respecte les
 * imports du fichier plutôt qu'expander en chemins absolus). En cas
 * d'échec ts-morph (rare, types circulaires), fallback `unknown`.
 */
function safeTypeText(type: any, node: any): string {
  if (!type) return 'unknown'
  try {
    return type.getText(node)
  } catch {
    try {
      return type.getText()
    } catch {
      return 'unknown'
    }
  }
}

// ─── Callable units (pour scanner les call sites) ───────────────────────────

interface CallableUnit {
  name: string   // "foo" ou "ClassName.method"
  body: Node
}

/**
 * Toutes les unités où un call site peut apparaître. On capture les fonctions
 * non-exportées aussi : un helper interne qui appelle un export doit produire
 * son edge — sinon on sous-compte la consommation d'une API.
 */
function getCallableUnits(sf: SourceFile): CallableUnit[] {
  const out: CallableUnit[] = []

  for (const fd of sf.getFunctions()) {
    const body = fd.getBody()
    const name = fd.getName()
    if (body && name) out.push({ name, body })
  }

  for (const cd of sf.getClasses()) {
    const className = cd.getName() ?? '<anonymous>'
    for (const method of cd.getMethods()) {
      const body = method.getBody()
      if (body) out.push({ name: `${className}.${method.getName()}`, body })
    }
    const ctor = cd.getConstructors()[0]
    if (ctor) {
      const body = ctor.getBody()
      if (body) out.push({ name: `${className}.constructor`, body })
    }
  }

  // Limité aux VariableStatement au scope du fichier — évite de re-capturer
  // les closures imbriquées qui seraient déjà couvertes par le body parent.
  for (const vs of sf.getVariableStatements()) {
    for (const vd of vs.getDeclarations()) {
      const init = vd.getInitializer()
      if (!init) continue
      const k = init.getKind()
      if (k !== SyntaxKind.ArrowFunction && k !== SyntaxKind.FunctionExpression) continue
      const body = (init as any).getBody?.() as Node | undefined
      if (body) out.push({ name: vd.getName(), body })
    }
  }

  return out
}

/**
 * Visite chaque CallExpression / NewExpression dans le node ET ses descendants.
 * `forEachDescendant` en ts-morph exclut le nœud lui-même — important ici car
 * le body d'un arrow avec expression body (`() => foo()`) EST le call.
 */
function visitCalls(root: Node, fn: (call: CallExpression | NewExpression) => void): void {
  const walk = (n: Node) => {
    const k = n.getKind()
    if (k === SyntaxKind.CallExpression || k === SyntaxKind.NewExpression) {
      fn(n as CallExpression | NewExpression)
    }
    n.forEachChild(walk)
  }
  walk(root)
}

// ─── Import map ──────────────────────────────────────────────────────────────

function getImportMap(sf: SourceFile, rootDir: string): ImportMaps {
  const named = new Map<string, { file: string; originalName: string }>()
  const namespace = new Map<string, string>()

  for (const imp of sf.getImportDeclarations()) {
    const target = imp.getModuleSpecifierSourceFile()
    if (!target) continue
    const targetPath = relativize(target.getFilePath(), rootDir)
    if (!targetPath) continue
    if (targetPath.includes('node_modules')) continue
    if (targetPath.startsWith('..')) continue
    if (targetPath.endsWith('.d.ts')) continue

    for (const spec of imp.getNamedImports()) {
      const originalName = spec.getName()
      const localName = spec.getAliasNode()?.getText() ?? originalName
      named.set(localName, { file: targetPath, originalName })
    }

    const defaultImport = imp.getDefaultImport()
    if (defaultImport) {
      named.set(defaultImport.getText(), { file: targetPath, originalName: 'default' })
    }

    const nsImport = imp.getNamespaceImport()
    if (nsImport) {
      namespace.set(nsImport.getText(), targetPath)
    }
  }

  return { named, namespace }
}

// ─── Callee resolution ───────────────────────────────────────────────────────

function resolveCallee(
  call: CallExpression | NewExpression,
  maps: ImportMaps,
): { file: string; name: string } | null {
  const expr = call.getExpression()
  const exprKind = expr.getKind()

  if (exprKind === SyntaxKind.Identifier) {
    const name = expr.getText()
    const info = maps.named.get(name)
    if (info) return { file: info.file, name: info.originalName }
    return null
  }

  if (exprKind === SyntaxKind.PropertyAccessExpression) {
    const pa = expr as any
    const left = pa.getExpression?.()
    if (!left || left.getKind() !== SyntaxKind.Identifier) return null
    const nsFile = maps.namespace.get(left.getText())
    if (!nsFile) return null
    const propName = pa.getName?.()
    if (!propName) return null
    return { file: nsFile, name: propName }
  }

  return null
}

// ─── Argument & return type extraction ──────────────────────────────────────

function extractArgTypes(call: CallExpression | NewExpression): string[] {
  return call.getArguments().map((arg) => {
    const t = arg.getType()
    // `add(1, 2)` : le type de `1` est le literal `1`, pas `number`. Pour la
    // carte structurelle on veut ce qui circule, pas la valeur exacte —
    // widener les literal primitifs à leur base. `getBaseTypeOfLiteralType`
    // est no-op sur les types non-littéraux.
    return safeTypeText(t.getBaseTypeOfLiteralType(), arg)
  })
}

function extractReturnType(call: CallExpression | NewExpression): string {
  // Sur un CallExpression / NewExpression, `.getType()` = le type de la
  // valeur retournée au call site (différent de getReturnType() qui serait
  // la return type de la signature de la fonction — non définie sur
  // NewExpression).
  const t = call.getType()
  return safeTypeText(t.getBaseTypeOfLiteralType(), call)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function relativize(absPath: string, rootDir: string): string | null {
  const rel = path.relative(rootDir, absPath).replace(/\\/g, '/')
  if (!rel || rel.startsWith('..')) return null
  return rel
}

function compareSignatures(a: TypedSignature, b: TypedSignature): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1
  if (a.line !== b.line) return a.line - b.line
  return a.exportName < b.exportName ? -1 : a.exportName > b.exportName ? 1 : 0
}

function compareCallEdges(a: TypedCallEdge, b: TypedCallEdge): number {
  if (a.from !== b.from) return a.from < b.from ? -1 : 1
  if (a.line !== b.line) return a.line - b.line
  if (a.to !== b.to) return a.to < b.to ? -1 : 1
  return 0
}
