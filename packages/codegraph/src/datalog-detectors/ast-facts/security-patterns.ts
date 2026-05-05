import { type SourceFile, Node, SyntaxKind } from 'ts-morph'
import { findContainingSymbol } from '../../extractors/_shared/ast-helpers.js'
import type {
  SecretVarRefCandidateFact,
  CorsConfigCandidateFact,
  TlsUnsafeCandidateFact,
  WeakRandomCandidateFact,
} from './types.js'

const SECURITY_SECRET_NAME_RE =
  /^(password|passwd|pwd|secret|token|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|client[-_]?secret|jwt|nonce|sessionid|csrf|otp|priv(ate)?[-_]?key|encryption[-_]?key)$/i

function detectSecuritySecretKind(name: string): string {
  const m = name.match(SECURITY_SECRET_NAME_RE)
  return m ? m[0].toLowerCase() : ''
}

function isSecurityMathRandomCall(call: Node): boolean {
  if (!Node.isCallExpression(call)) return false
  const callee = call.getExpression()
  return Node.isPropertyAccessExpression(callee)
    && callee.getExpression().getText() === 'Math'
    && callee.getName() === 'random'
}

function classifySecurityCorsOriginKind(init: Node | undefined): string {
  if (!init) return 'dynamic'
  if (Node.isStringLiteral(init)) {
    return init.getLiteralValue() === '*' ? 'wildcard' : 'literal'
  }
  if (Node.isPropertyAccessExpression(init)
    && /req\.headers\.|request\.headers\./.test(init.getText())) {
    return 'reflective'
  }
  return 'dynamic'
}

function collectSecurityCorsCall(
  call: Node,
  callee: Node,
  args: Node[],
  relPath: string,
  line: number,
  corsOut: CorsConfigCandidateFact[],
): void {
  if (!Node.isIdentifier(callee) || callee.getText() !== 'cors') return
  if (args.length === 0 || !Node.isObjectLiteralExpression(args[0])) return
  const originProp = args[0].getProperty('origin')
  if (!originProp || !Node.isPropertyAssignment(originProp)) return
  corsOut.push({
    file: relPath, line,
    originKind: classifySecurityCorsOriginKind(originProp.getInitializer()),
    containingSymbol: findContainingSymbol(call),
  })
}

function readSecurityCalleeText(callee: Node): string {
  if (Node.isIdentifier(callee)) return callee.getText()
  if (Node.isPropertyAccessExpression(callee)) return callee.getText()
  return ''
}

interface SecretRefSink {
  call: Node
  calleeText: string
  relPath: string
  line: number
  out: SecretVarRefCandidateFact[]
}

function pushSecretRefIfMatch(varName: string, sink: SecretRefSink): void {
  const kind = detectSecuritySecretKind(varName)
  if (!kind) return
  sink.out.push({
    file: sink.relPath, line: sink.line,
    varName, kind, callee: sink.calleeText,
    containingSymbol: findContainingSymbol(sink.call),
  })
}

function collectSecretRefsFromArg(arg: Node, sink: SecretRefSink): void {
  if (Node.isIdentifier(arg)) {
    pushSecretRefIfMatch(arg.getText(), sink)
    return
  }
  if (!Node.isObjectLiteralExpression(arg)) return
  for (const prop of arg.getProperties()) {
    if (!Node.isShorthandPropertyAssignment(prop)) continue
    pushSecretRefIfMatch(prop.getName(), sink)
  }
}

function collectSecurityCallExpressionFacts(
  sf: SourceFile,
  relPath: string,
  secretRefsOut: SecretVarRefCandidateFact[],
  corsOut: CorsConfigCandidateFact[],
): void {
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const line = call.getStartLineNumber()
    const callee = call.getExpression()
    const args = call.getArguments()
    collectSecurityCorsCall(call, callee, args, relPath, line, corsOut)
    const calleeText = readSecurityCalleeText(callee)
    if (!calleeText) continue
    const sink: SecretRefSink = { call, calleeText, relPath, line, out: secretRefsOut }
    for (const arg of args) collectSecretRefsFromArg(arg, sink)
  }
}

function collectSecurityWeakRandoms(
  sf: SourceFile,
  relPath: string,
  weakRandomsOut: WeakRandomCandidateFact[],
): void {
  for (const v of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = v.getInitializer()
    if (!init || !Node.isCallExpression(init)) continue
    if (!isSecurityMathRandomCall(init)) continue
    const nameNode = v.getNameNode()
    const varName = Node.isIdentifier(nameNode) ? nameNode.getText() : ''
    weakRandomsOut.push({
      file: relPath,
      line: v.getStartLineNumber(),
      varName,
      secretKind: detectSecuritySecretKind(varName),
      containingSymbol: findContainingSymbol(v),
    })
  }
}

function collectSecurityTlsUnsafe(
  sf: SourceFile,
  relPath: string,
  tlsOut: TlsUnsafeCandidateFact[],
): void {
  for (const obj of sf.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
    const line = obj.getStartLineNumber()
    for (const prop of obj.getProperties()) {
      if (!Node.isPropertyAssignment(prop)) continue
      const name = prop.getName()
      const init = prop.getInitializer()
      if (!init) continue
      if ((name !== 'rejectUnauthorized' && name !== 'strictSSL')
        || init.getText() !== 'false') continue
      tlsOut.push({
        file: relPath, line, key: name,
        containingSymbol: findContainingSymbol(obj),
      })
    }
  }
}

export function visitSecurityPatternsCandidates(
  sf: SourceFile,
  relPath: string,
  secretRefsOut: SecretVarRefCandidateFact[],
  corsOut: CorsConfigCandidateFact[],
  tlsOut: TlsUnsafeCandidateFact[],
  weakRandomsOut: WeakRandomCandidateFact[],
): void {
  collectSecurityCallExpressionFacts(sf, relPath, secretRefsOut, corsOut)
  collectSecurityWeakRandoms(sf, relPath, weakRandomsOut)
  collectSecurityTlsUnsafe(sf, relPath, tlsOut)
}
