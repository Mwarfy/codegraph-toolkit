/**
 * Symbol-Level Reference Detector (inspiré d'aider)
 *
 * Produit un graphe function→function : pour chaque fonction exportée (ou
 * méthode de classe exportée, ou arrow assignée à un export), parcourt le
 * body et détecte les Identifiers qui correspondent à un nom importé.
 *
 * Résultat : edges (from, to, line) où from/to sont "file:symbol" et line
 * est la ligne exacte dans le fichier "from".
 *
 * Usage en aval :
 *   1. Symbol-level PageRank (ranking de symboles, pas de fichiers — plus
 *      précis : "handleSystemRoutes" peut être rank 1, "system.ts" rank 3).
 *   2. find_references précis sans grep (on a les lignes exactes d'appel
 *      dans les corps de fonctions, plus l'info "appelé depuis quelle
 *      fonction" — avantage substantiel pour comprendre l'impact).
 *
 * Trade-off vs ts-morph TypeChecker complet :
 *   - Ne résout PAS les alias d'import (`import { foo as bar }` : on
 *     enregistre l'usage sous le nom local `bar`, la résolution au
 *     target est correcte par l'importMap).
 *   - Syntaxique : un Identifier en position de propriété (`obj.foo`) n'est
 *     pas confondu avec un export nommé `foo` (on filtre).
 *   - Namespace imports (`import * as X`) : résolus SYNTAXIQUEMENT via
 *     PropertyAccessExpression. `X.foo()` → edge vers `target:foo`. Les
 *     usages bare de `X` (sans `.`) sont ignorés — impossible de savoir
 *     quel symbole sans TypeChecker. Couvre les cas concrets de Sentinel
 *     (pm, tools MCP, approval, enrichment) pour un coût syntaxique nul.
 */

import { Project, SyntaxKind, Node, SourceFile } from 'ts-morph'
import * as path from 'node:path'

export interface SymbolRef {
  /** "file:symbolName" — la fonction qui contient la référence. */
  from: string
  /** "file:symbolName" — l'export référencé. */
  to: string
  /** Ligne exacte dans le fichier source du from. */
  line: number
}

export interface SymbolRefsResult {
  refs: SymbolRef[]
  /** Liste des symboles exportés vus. Clé = "file:symbol". Utile pour
   *  valider qu'un "to" est bien un export tracké. */
  exportedSymbols: Set<string>
}

interface ExportedUnit {
  name: string
  body: Node
  startLine: number
}

/**
 * Extrait les unités de code d'un fichier. Une unité = une fonction
 * indépendamment analysable. On capture TOUTES les fonctions (exportées ou
 * non) — les non-exportées sont nécessaires pour :
 *   1. Tracer les call sites complets (find_references : un appel à sendGmail
 *      depuis un helper interne doit apparaître).
 *   2. PageRank complet : un helper non-exporté qui appelle emit() 50 fois
 *      contribue correctement au rank d'emit, même s'il n'est jamais lui-même
 *      un target.
 *
 * `exportedOnly` (marqué via le flag retourné) permet aux consommateurs de
 * filtrer ultérieurement quand ils ne veulent que le graphe inter-exports.
 */
type Unit = ExportedUnit & { exported: boolean }

function pushFunctionDeclarations(sf: SourceFile, out: Unit[]): void {
  for (const fd of sf.getFunctions()) {
    const name = fd.getName()
    if (!name) continue
    const body = fd.getBody()
    if (!body) continue
    out.push({ name, body, startLine: fd.getStartLineNumber(), exported: fd.isExported() })
  }
}

/**
 * BUG HISTORIQUE (fix 2026-04-18) : la 1re version ne capturait que
 * cd.getMethods() qui EXCLUT les getters/setters en ts-morph. Resultat :
 * un `get tools()` qui wrappait les call sites reels (ex: sendGmail dans
 * FulfillmentBlock) etait invisible, et find_references remontait zero
 * caller. Fix : traiter getters/setters comme des methodes avec un
 * prefixe "get "/"set " pour les distinguer.
 */
function pushClassMembers(sf: SourceFile, out: Unit[]): void {
  for (const cd of sf.getClasses()) {
    const className = cd.getName() || '<anonymous-class>'
    const exported = cd.isExported()
    for (const m of cd.getMethods()) {
      const body = m.getBody()
      if (body) out.push({ name: `${className}.${m.getName()}`, body, startLine: m.getStartLineNumber(), exported })
    }
    for (const g of cd.getGetAccessors()) {
      const body = g.getBody()
      if (body) out.push({ name: `${className}.get ${g.getName()}`, body, startLine: g.getStartLineNumber(), exported })
    }
    for (const s of cd.getSetAccessors()) {
      const body = s.getBody()
      if (body) out.push({ name: `${className}.set ${s.getName()}`, body, startLine: s.getStartLineNumber(), exported })
    }
    const ctor = cd.getConstructors()[0]
    if (ctor) {
      const body = ctor.getBody()
      if (body) out.push({ name: `${className}.constructor`, body, startLine: ctor.getStartLineNumber(), exported })
    }
  }
}

/**
 * Variables-fonctions (arrow/function expressions). On se limite aux
 * VariableStatement au scope du fichier pour eviter de capturer les
 * closures imbriquees via getVariableDeclarations() (qui remonterait
 * aussi les vars internes des fonctions).
 */
function pushFunctionVarDeclarations(sf: SourceFile, out: Unit[]): void {
  for (const vs of sf.getVariableStatements()) {
    const exported = vs.isExported()
    for (const vd of vs.getDeclarations()) {
      const init = vd.getInitializer()
      if (!init) continue
      const kind = init.getKind()
      if (kind !== SyntaxKind.ArrowFunction && kind !== SyntaxKind.FunctionExpression) continue
      const body = (init as any).getBody?.() as Node | undefined
      if (!body) continue
      out.push({ name: vd.getName(), body, startLine: vd.getStartLineNumber(), exported })
    }
  }
}

function getAllUnits(sf: SourceFile): Unit[] {
  const units: Unit[] = []
  pushFunctionDeclarations(sf, units)
  pushClassMembers(sf, units)
  pushFunctionVarDeclarations(sf, units)
  return units
}

/**
 * Maps produites pour un fichier donné :
 *   - `named` : import nommé ou défaut → { file cible, nom d'origine }.
 *     Ex: `import { foo, bar as baz } from './x.ts'` → `foo → x.ts:foo`,
 *     `baz → x.ts:bar`.
 *   - `namespace` : import namespace → file cible.
 *     Ex: `import * as pm from './pm.ts'` → `pm → pm.ts`. La résolution
 *     du symbole concret (X.foo) se fait au moment du scan via
 *     PropertyAccessExpression dans collectRefs.
 */
interface ImportMaps {
  named: Map<string, { file: string; originalName: string }>
  namespace: Map<string, string>
}

function getImportMap(sf: SourceFile, rootDir: string): ImportMaps {
  const named = new Map<string, { file: string; originalName: string }>()
  const namespace = new Map<string, string>()

  for (const imp of sf.getImportDeclarations()) {
    const target = imp.getModuleSpecifierSourceFile()
    if (!target) continue
    const targetPath = path
      .relative(rootDir, target.getFilePath())
      .replace(/\\/g, '/')

    // Skip les imports externes (node_modules, .d.ts, chemin absolu hors rootDir).
    // Sans ça, `useState` du @types/react remonte dans les top callees et
    // pollue les PageRanks en aval.
    if (targetPath.includes('node_modules')) continue
    if (targetPath.startsWith('..')) continue
    if (targetPath.endsWith('.d.ts')) continue

    // import { foo } / import { foo as bar }
    for (const spec of imp.getNamedImports()) {
      const originalName = spec.getName()
      const localName = spec.getAliasNode()?.getText() || originalName
      named.set(localName, { file: targetPath, originalName })
    }

    // import defaultFoo from './x'
    const defaultImport = imp.getDefaultImport()
    if (defaultImport) {
      const localName = defaultImport.getText()
      named.set(localName, { file: targetPath, originalName: 'default' })
    }

    // import * as X from './x' — on note le binding. Résolu plus tard en
    // regardant les PropertyAccess `X.foo` dans les bodies. Les usages
    // bare de `X` (passés à une fonction, etc.) restent hors graphe car
    // impossible de savoir quel symbole sans TypeChecker.
    const nsImport = imp.getNamespaceImport()
    if (nsImport) {
      namespace.set(nsImport.getText(), targetPath)
    }
  }

  return { named, namespace }
}

/**
 * Parcourt le body d'une fonction, collecte chaque Identifier qui matche
 * un nom importé, retourne (line, importInfo). Dedup par (targetFile:name, line)
 * pour qu'un appel répété sur la même ligne compte une fois.
 *
 * Deux chemins :
 *   - Import nommé / défaut : un Identifier matchant le local name suffit
 *     (on filtre les faux positifs position-propriété et clé d'objet).
 *   - Namespace import : l'Identifier `X` doit être en position expression
 *     d'un PropertyAccess (`X.foo`). On émet alors un edge vers `target:foo`.
 *     Un `X` bare (passé en argument, réaffecté) est ignoré.
 */
type RefHit = { line: number; file: string; name: string }

/**
 * `foo.bar` : si `bar` est notre node (right side du PropertyAccess), on
 * skip car ce n'est pas un import — c'est une property access. Le node
 * gauche `foo` peut etre un import lui-meme et est traite separement.
 */
function isPropertyAccessRightSide(node: Node, parent: Node, text: string): boolean {
  if (parent.getKind() !== SyntaxKind.PropertyAccessExpression) return false
  const pa = parent as any
  return pa.getName?.() === text && pa.getExpression?.() !== node
}

function isObjectPropertyName(node: Node, parent: Node): boolean {
  if (parent.getKind() !== SyntaxKind.PropertyAssignment) return false
  const nameNode = (parent as any).getNameNode?.()
  return nameNode === node
}

/**
 * Chemin 1 : import nomme ou defaut. Returns null si skip (false-pos),
 * sinon le hit.
 */
function tryNamedImportRef(
  node: Node,
  text: string,
  parent: Node | undefined,
  maps: ImportMaps,
): RefHit | null {
  const info = maps.named.get(text)
  if (!info) return null
  if (parent && isPropertyAccessRightSide(node, parent, text)) return null
  if (parent && isObjectPropertyName(node, parent)) return null

  const line = node.getSourceFile().getLineAndColumnAtPos(node.getStart()).line
  return { line, file: info.file, name: info.originalName }
}

/**
 * Chemin 2 : namespace import. `X` doit etre en position expression
 * d'1 PropertyAccess (`X.foo`). Returns null si skip.
 */
function tryNamespaceImportRef(
  node: Node,
  text: string,
  parent: Node | undefined,
  maps: ImportMaps,
): RefHit | null {
  const nsFile = maps.namespace.get(text)
  if (!nsFile) return null
  if (!parent || parent.getKind() !== SyntaxKind.PropertyAccessExpression) return null
  const pa = parent as any
  if (pa.getExpression?.() !== node) return null  // skip `obj.X` ou X est un property name

  const propertyName = pa.getName?.()
  if (!propertyName || typeof propertyName !== 'string') return null

  const line = node.getSourceFile().getLineAndColumnAtPos(node.getStart()).line
  return { line, file: nsFile, name: propertyName }
}

function collectRefs(body: Node, maps: ImportMaps): RefHit[] {
  const seen = new Set<string>() // dedup par targetKey:line
  const hits: RefHit[] = []

  const tryEmit = (hit: RefHit | null): void => {
    if (!hit) return
    const key = `${hit.file}:${hit.name}:${hit.line}`
    if (seen.has(key)) return
    seen.add(key)
    hits.push(hit)
  }

  body.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.Identifier) return
    const text = node.getText()
    const parent = node.getParent()

    const named = tryNamedImportRef(node, text, parent, maps)
    if (named) { tryEmit(named); return }
    tryEmit(tryNamespaceImportRef(node, text, parent, maps))
  })

  return hits
}

/**
 * Analyse tous les fichiers et retourne les edges symbol→symbol.
 * Nécessite un ts-morph Project déjà chargé (sharedProject) — partagé avec
 * analyzeExports et analyzeComplexity pour éviter l'OOM.
 */
export async function analyzeSymbolRefs(
  rootDir: string,
  files: string[],
  sharedProject: Project,
): Promise<SymbolRefsResult> {
  const refs: SymbolRef[] = []
  const exportedSymbols = new Set<string>()
  const fileSet = new Set(files)

  for (const sf of sharedProject.getSourceFiles()) {
    const filePath = path.relative(sf.getFilePath(), rootDir).replace(/\\/g, '/')
    // Note legacy: ce chemin était `files.includes(filePath)`. Garder le check
    // sur fileSet pour parité.
    const rel = path.relative(rootDir, sf.getFilePath()).replace(/\\/g, '/')
    if (!fileSet.has(rel)) continue
    void filePath
    const bundle = extractSymbolRefsFileBundle(sf, rel, rootDir)
    for (const e of bundle.exportedSymbols) exportedSymbols.add(e)
    refs.push(...bundle.refs)
  }

  return { refs, exportedSymbols }
}

/**
 * Bundle per-file : les symboles exportés + les refs sortantes
 * détectées. Réutilisable côté Salsa.
 */
export interface SymbolRefsFileBundle {
  exportedSymbols: string[]
  refs: SymbolRef[]
}

export function extractSymbolRefsFileBundle(
  sf: SourceFile,
  relPath: string,
  rootDir: string,
): SymbolRefsFileBundle {
  const importMap = getImportMap(sf, rootDir)
  const units = getAllUnits(sf)

  const exportedSymbols: string[] = []
  const refs: SymbolRef[] = []

  for (const unit of units) {
    if (unit.exported) exportedSymbols.push(`${relPath}:${unit.name}`)
    const fromId = `${relPath}:${unit.name}`
    const hits = collectRefs(unit.body, importMap)
    for (const hit of hits) {
      const toId = `${hit.file}:${hit.name}`
      refs.push({ from: fromId, to: toId, line: hit.line })
    }
  }

  return { exportedSymbols, refs }
}
