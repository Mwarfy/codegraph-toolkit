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
import { findContainingSymbol, makeIsExemptForMarker } from './_shared/ast-helpers.js'

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

interface CalleeInfo {
  methodName: string
  objectName: string | null
  calleeText: string
}

export function extractTaintSinksFileBundle(
  sf: SourceFile,
  relPath: string,
): TaintSinksFileBundle {
  if (TEST_FILE_RE.test(relPath)) return { sinks: [] }
  const sinks: TaintSink[] = []
  const isExempt = makeIsExemptForMarker(sf, 'taint-ok')

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const sink = analyzeOneCallForSink(call, relPath, isExempt)
    if (sink) sinks.push(sink)
  }
  return { sinks }
}

function analyzeOneCallForSink(
  call: import('ts-morph').CallExpression,
  relPath: string,
  isExempt: (line: number) => boolean,
): TaintSink | null {
  const info = readCalleeInfo(call.getExpression())
  if (!info) return null
  const kind = METHOD_TO_KIND.get(info.methodName)
  if (!kind) return null
  if (!isHighConfidenceCall(info, kind)) return null
  const line = call.getStartLineNumber()
  if (isExempt(line)) return null
  return {
    file: relPath,
    line,
    kind,
    callee: info.calleeText,
    containingSymbol: findContainingSymbol(call),
  }
}

function readCalleeInfo(callee: Node): CalleeInfo | null {
  if (Node.isIdentifier(callee)) {
    const name = callee.getText()
    return { methodName: name, objectName: null, calleeText: name }
  }
  if (Node.isPropertyAccessExpression(callee)) {
    const exprNode = callee.getExpression()
    let objectName: string | null = null
    if (Node.isIdentifier(exprNode)) objectName = exprNode.getText()
    // ex: childProcess.execSync — on prend le LAST segment de l'objet.
    else if (Node.isPropertyAccessExpression(exprNode)) objectName = exprNode.getName()
    return { methodName: callee.getName(), objectName, calleeText: callee.getText() }
  }
  return null
}

/**
 * Filtre par confiance : sans préfixe objet de haute confiance, skip — sinon
 * on flaggerait `arr.exec()` comme command exec. Sans préfixe : seuls eval
 * et fetch sont uniques sans contexte.
 */
function isHighConfidenceCall(info: CalleeInfo, kind: TaintSink['kind']): boolean {
  if (info.objectName) return HIGH_CONFIDENCE_OBJECTS[kind].test(info.objectName)
  return info.methodName === 'eval' || info.methodName === 'fetch'
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
