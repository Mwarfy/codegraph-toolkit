import { type SourceFile, Node, SyntaxKind } from 'ts-morph'
import { findContainingSymbol } from '../../extractors/_shared/ast-helpers.js'
import type { TaintSinkCandidateFact } from './types.js'

const SINK_METHOD_TO_KIND = new Map<string, string>()
;(() => {
  const patterns: Array<[string, string[]]> = [
    ['sql',      ['query', 'raw', 'execute']],
    ['eval',     ['eval']],
    ['exec',     ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']],
    ['fs-read',  ['readFile', 'readFileSync', 'createReadStream', 'readdir', 'readdirSync']],
    ['fs-write', ['writeFile', 'writeFileSync', 'createWriteStream', 'appendFile', 'unlink', 'rm', 'rmSync']],
    ['http-out', ['fetch', 'request', 'get', 'post', 'put', 'delete', 'patch']],
    ['html-out', ['send', 'render', 'innerHTML', 'outerHTML']],
    ['log',      ['info', 'warn', 'error', 'debug', 'log', 'trace', 'fatal']],
    ['redirect', ['redirect', 'setHeader', 'writeHead']],
  ]
  for (const [kind, methods] of patterns) {
    for (const m of methods) SINK_METHOD_TO_KIND.set(m, kind)
  }
})()

const SINK_HIGH_CONFIDENCE: Record<string, RegExp> = {
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

export function visitTaintSinkCandidates(
  sf: SourceFile,
  relPath: string,
  out: TaintSinkCandidateFact[],
): void {
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression()
    let methodName: string | null = null
    let objectName: string | null = null
    let calleeText = ''
    if (Node.isIdentifier(callee)) {
      methodName = callee.getText()
      calleeText = methodName
    } else if (Node.isPropertyAccessExpression(callee)) {
      methodName = callee.getName()
      calleeText = callee.getText()
      const exprNode = callee.getExpression()
      if (Node.isIdentifier(exprNode)) objectName = exprNode.getText()
      else if (Node.isPropertyAccessExpression(exprNode)) objectName = exprNode.getName()
    } else continue
    if (!methodName) continue
    const kind = SINK_METHOD_TO_KIND.get(methodName)
    if (!kind) continue
    const hc = objectName
      ? SINK_HIGH_CONFIDENCE[kind].test(objectName)
      : (methodName === 'eval' || methodName === 'fetch')
    if (!hc) continue
    out.push({
      file: relPath,
      line: call.getStartLineNumber(),
      kind,
      callee: calleeText,
      containingSymbol: findContainingSymbol(call),
    })
  }
}
