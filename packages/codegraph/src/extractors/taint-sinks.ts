/**
 * Taint sinks — détecteur déterministe AST (Phase 4 Tier 10).
 *
 * Capture les call-sites de fonctions DANGEREUSES où un user input
 * non-validé peut causer un dégât :
 *
 *   - **sql** : db.query, pool.query, client.query, knex.raw, sql\`...\`
 *   - **eval** : eval, Function constructor (déjà via eval-calls)
 *   - **exec** : child_process.exec, execSync, spawn, spawnSync
 *   - **fs-read** : fs.readFile, fs.readFileSync, createReadStream
 *   - **fs-write** : fs.writeFile, fs.writeFileSync, createWriteStream
 *   - **http-out** : fetch, axios.get/post, http.get, https.get (SSRF)
 *   - **html-out** : res.send avec template, innerHTML, dangerouslySetInnerHTML (XSS)
 *
 * Émet le fact `Sink(file, line, kind, callee)`. Combiné avec
 * `EntryPoint` + `SymbolCallEdge` transitif + ¬`Sanitizer`, on
 * obtient des composites taint-aware (CodeQL style mais lite).
 *
 * Inspiration : CWE Top 25 + CodeQL standard library (sources/sinks).
 *
 * Convention exempt : `// taint-ok: <reason>` ligne précédente.
 */

import { type Project, type SourceFile, Node, SyntaxKind } from 'ts-morph'

export type TaintSinkKind =
  | 'sql'
  | 'eval'
  | 'exec'
  | 'fs-read'
  | 'fs-write'
  | 'http-out'
  | 'html-out'
  | 'log'        // Tier 16 — logger.info/warn/error/debug (CWE-117 log injection)
  | 'redirect'   // Tier 16 — res.redirect / Location header (CWE-601 open redirect)

export interface TaintSink {
  file: string
  line: number
  kind: TaintSinkKind
  /** Le callee complet (ex: "db.query", "fs.readFile", "fetch"). */
  callee: string
  /** Le symbole englobant (function/method/arrow). */
  containingSymbol: string
}

export interface TaintSinksFileBundle {
  sinks: TaintSink[]
}

const TEST_FILE_RE = /(\.test\.tsx?|\.spec\.tsx?|(^|\/)tests?\/|(^|\/)fixtures?\/)/

// Patterns de méthode names → kind. Le matcher est sur le LAST property
// access (ex: `pool.query` matche method "query"). Volontaire : on accepte
// du false-positive (un `myObj.query()` qui n'est pas SQL) plutôt que
// rater des vrais sinks.
const SINK_PATTERNS: Array<{ kind: TaintSinkKind; methods: string[] }> = [
  { kind: 'sql',      methods: ['query', 'raw', 'execute'] },
  { kind: 'eval',     methods: ['eval'] },
  { kind: 'exec',     methods: ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork'] },
  { kind: 'fs-read',  methods: ['readFile', 'readFileSync', 'createReadStream', 'readdir', 'readdirSync'] },
  { kind: 'fs-write', methods: ['writeFile', 'writeFileSync', 'createWriteStream', 'appendFile', 'unlink', 'rm', 'rmSync'] },
  { kind: 'http-out', methods: ['fetch', 'request', 'get', 'post', 'put', 'delete', 'patch'] },
  { kind: 'html-out', methods: ['send', 'render', 'innerHTML', 'outerHTML'] },
  // Tier 16
  { kind: 'log',      methods: ['info', 'warn', 'error', 'debug', 'log', 'trace', 'fatal'] },
  { kind: 'redirect', methods: ['redirect', 'setHeader', 'writeHead'] },
]

// Map inverse pour lookup rapide.
const METHOD_TO_KIND = new Map<string, TaintSinkKind>()
for (const { kind, methods } of SINK_PATTERNS) {
  for (const m of methods) METHOD_TO_KIND.set(m, kind)
}

// Préfixes objet qui RENFORCENT la classification. Un `pool.query` est
// presque sûrement SQL ; un `obj.query` peut être autre chose. Ces
// préfixes augmentent la confiance.
const HIGH_CONFIDENCE_OBJECTS: Record<TaintSinkKind, RegExp> = {
  'sql':      /^(db|pool|client|knex|prisma|sql|connection|conn|database)$/i,
  'eval':     /.*/,
  'exec':     /^(child_process|cp|childProcess)$/i,
  'fs-read':  /^(fs|fsPromises|fsp)$/i,
  'fs-write': /^(fs|fsPromises|fsp)$/i,
  'http-out': /^(axios|http|https|got|fetch|node_fetch|nodeFetch)$/i,
  'html-out': /^(res|response|element|document)$/i,
  'log':      /^(logger|log|console|pino|winston|bunyan)$/i,
  'redirect': /^(res|response|ctx|reply)$/i,
}

export function extractTaintSinksFileBundle(
  sf: SourceFile,
  relPath: string,
): TaintSinksFileBundle {
  if (TEST_FILE_RE.test(relPath)) return { sinks: [] }
  const sinks: TaintSink[] = []

  const lines = sf.getFullText().split('\n')
  const isExempt = (line: number): boolean => {
    if (line < 2 || line - 2 >= lines.length) return false
    const prev = lines[line - 2]
    return /\/\/\s*taint-ok\b/.test(prev)
  }

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression()
    let methodName: string | null = null
    let objectName: string | null = null
    let calleeText: string

    if (Node.isIdentifier(callee)) {
      methodName = callee.getText()
      calleeText = methodName
    } else if (Node.isPropertyAccessExpression(callee)) {
      methodName = callee.getName()
      const exprNode = callee.getExpression()
      if (Node.isIdentifier(exprNode)) objectName = exprNode.getText()
      else if (Node.isPropertyAccessExpression(exprNode)) {
        // ex: childProcess.execSync — on prend le LAST segment de
        // l'objet (childProcess) ou le full text si plusieurs niveaux.
        objectName = exprNode.getName()
      }
      calleeText = callee.getText()
    } else {
      continue
    }

    if (!methodName) continue
    const kind = METHOD_TO_KIND.get(methodName)
    if (!kind) continue

    // Filtre par confiance : si pas de préfixe objet de haute confiance,
    // on skip — sinon on flaggerait `arr.exec()` comme command exec.
    if (objectName) {
      const re = HIGH_CONFIDENCE_OBJECTS[kind]
      if (!re.test(objectName)) continue
    } else {
      // Identifier seul (eval, fetch, etc.). Seuls eval, fetch sont
      // suffisamment uniques pour être confiance haute sans préfixe.
      if (methodName !== 'eval' && methodName !== 'fetch') continue
    }

    const line = call.getStartLineNumber()
    if (isExempt(line)) continue

    sinks.push({
      file: relPath,
      line,
      kind,
      callee: calleeText,
      containingSymbol: findContainingSymbol(call),
    })
  }

  return { sinks }
}

function findContainingSymbol(node: Node): string {
  let current: Node | undefined = node.getParent()
  while (current) {
    if (Node.isFunctionDeclaration(current)) return current.getName() ?? ''
    if (Node.isMethodDeclaration(current)) {
      const cls = current.getFirstAncestorByKind(SyntaxKind.ClassDeclaration)
      const className = cls?.getName() ?? ''
      const methodName = current.getName()
      return className ? `${className}.${methodName}` : methodName
    }
    if (Node.isVariableDeclaration(current)) {
      const init = current.getInitializer()
      if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
        return current.getName()
      }
    }
    current = current.getParent()
  }
  return ''
}

export async function analyzeTaintSinks(
  rootDir: string,
  files: string[],
  project: Project,
): Promise<TaintSink[]> {
  const fileSet = new Set(files)
  const all: TaintSink[] = []

  for (const sf of project.getSourceFiles()) {
    const rel = relativize(sf.getFilePath(), rootDir)
    if (!rel || !fileSet.has(rel)) continue
    const bundle = extractTaintSinksFileBundle(sf, rel)
    all.push(...bundle.sinks)
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
