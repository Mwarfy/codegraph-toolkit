/**
 * Security patterns — extracteur deterministe AST (Phase 5 Tier 16).
 *
 * Capture 4 patterns de securite complementaires en un seul AST walk :
 *
 *   1. SecretVarRef — variable nommee password/token/secret/apiKey/...
 *      utilisee comme arg d'un call. Source pour CWE-312 (clear-text
 *      logging) quand le sink est un logger.
 *
 *   2. CorsConfig — `cors({ origin: '*' })` ou
 *      `cors({ origin: req.headers.origin })`. CWE-942.
 *
 *   3. TlsConfigUnsafe — `{ rejectUnauthorized: false }` dans options
 *      object. CWE-295.
 *
 *   4. WeakRandomCall — `Math.random()` utilise pour assigner une
 *      variable nommee comme un secret. CWE-338.
 *
 * Pattern exempt : `// security-ok: <reason>` ligne precedente.
 *
 * Pourquoi grouper : un seul AST walk = perf. 4 patterns simples chacun.
 */

import { type Project, type SourceFile, Node, SyntaxKind } from 'ts-morph'
import { findContainingSymbol, makeIsExemptForMarker } from './_shared/ast-helpers.js'

const TEST_FILE_RE = /(\.test\.tsx?|\.spec\.tsx?|(^|\/)tests?\/|(^|\/)fixtures?\/)/
const SECRET_NAME_RE = /^(password|passwd|pwd|secret|token|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|client[-_]?secret|jwt|nonce|sessionid|csrf|otp|priv(ate)?[-_]?key|encryption[-_]?key)$/i

export interface SecretVarRef {
  file: string
  line: number
  /** Le nom de la variable. */
  varName: string
  /** Le kind detecte (password, token, apiKey, ...). */
  kind: string
  /** Le callee qui consomme cette variable. */
  callee: string
  containingSymbol: string
}

export interface CorsConfig {
  file: string
  line: number
  /** Le kind detecte : 'wildcard' (origin='*'), 'reflective' (origin=req.headers.X), 'literal' (autre literal), 'dynamic' (autre). */
  originKind: string
  containingSymbol: string
}

export interface TlsConfigUnsafe {
  file: string
  line: number
  /** Le nom de la propriete : 'rejectUnauthorized' (false), 'NODE_TLS_REJECT_UNAUTHORIZED' (env), 'strictSSL' (false), etc. */
  key: string
  containingSymbol: string
}

export interface WeakRandomCall {
  file: string
  line: number
  /** Le nom de la variable assignee a Math.random(). '' si pas de var assign visible. */
  varName: string
  /** Le kind detecte si varName matche SECRET_NAME_RE. '' sinon. */
  secretKind: string
  containingSymbol: string
}

export interface SecurityPatternsFileBundle {
  secretRefs: SecretVarRef[]
  corsConfigs: CorsConfig[]
  tlsUnsafe: TlsConfigUnsafe[]
  weakRandoms: WeakRandomCall[]
}

function detectSecretKind(name: string): string {
  const m = name.match(SECRET_NAME_RE)
  return m ? m[0].toLowerCase() : ''
}

interface SecCtx {
  relPath: string
  isExempt: (line: number) => boolean
  out: SecurityPatternsFileBundle
}

export function extractSecurityPatternsFileBundle(
  sf: SourceFile,
  relPath: string,
): SecurityPatternsFileBundle {
  const out: SecurityPatternsFileBundle = {
    secretRefs: [], corsConfigs: [], tlsUnsafe: [], weakRandoms: [],
  }
  if (TEST_FILE_RE.test(relPath)) return out

  const ctx: SecCtx = {
    relPath,
    isExempt: makeIsExemptForMarker(sf, 'security-ok'),
    out,
  }

  scanCallExpressions(sf, ctx)
  scanVariableDeclarationsForWeakRandom(sf, ctx)
  scanObjectLiteralsForTlsUnsafe(sf, ctx)
  return out
}

// ─── Pass 1: CallExpression ─────────────────────────────────────────────────
//
// Cherche : cors({ origin: ... }) + secretVarRef en argument.

function scanCallExpressions(sf: SourceFile, ctx: SecCtx): void {
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const line = call.getStartLineNumber()
    if (ctx.isExempt(line)) continue
    detectCorsConfig(call, line, ctx)
    detectSecretRefArgs(call, line, ctx)
  }
}

function detectCorsConfig(
  call: ReturnType<SourceFile['getDescendantsOfKind']>[number] & { getExpression(): Node; getArguments(): Node[] },
  line: number,
  ctx: SecCtx,
): void {
  const callee = call.getExpression()
  if (!Node.isIdentifier(callee) || callee.getText() !== 'cors') return
  const args = call.getArguments()
  if (args.length === 0 || !Node.isObjectLiteralExpression(args[0])) return
  const originProp = args[0].getProperty('origin')
  if (!originProp || !Node.isPropertyAssignment(originProp)) return
  ctx.out.corsConfigs.push({
    file: ctx.relPath,
    line,
    originKind: classifyCorsOriginKind(originProp.getInitializer()),
    containingSymbol: findContainingSymbol(call as unknown as Node),
  })
}

function classifyCorsOriginKind(init: Node | undefined): string {
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

function detectSecretRefArgs(
  call: ReturnType<SourceFile['getDescendantsOfKind']>[number] & { getExpression(): Node; getArguments(): Node[] },
  line: number,
  ctx: SecCtx,
): void {
  const callee = call.getExpression()
  let calleeText = ''
  if (Node.isIdentifier(callee)) calleeText = callee.getText()
  else if (Node.isPropertyAccessExpression(callee)) calleeText = callee.getText()
  if (!calleeText) return

  const callNode = call as unknown as Node
  for (const arg of call.getArguments()) {
    if (Node.isIdentifier(arg)) {
      pushSecretRefIfNamed(arg.getText(), line, calleeText, callNode, ctx)
    } else if (Node.isObjectLiteralExpression(arg)) {
      collectShorthandSecretRefs(arg, line, calleeText, callNode, ctx)
    }
  }
}

function collectShorthandSecretRefs(
  obj: Node,
  line: number,
  calleeText: string,
  callNode: Node,
  ctx: SecCtx,
): void {
  // logger.info({ password, apiKey }) — shorthand prop names matching secret pattern
  if (!Node.isObjectLiteralExpression(obj)) return
  for (const prop of obj.getProperties()) {
    if (Node.isShorthandPropertyAssignment(prop)) {
      pushSecretRefIfNamed(prop.getName(), line, calleeText, callNode, ctx)
    }
  }
}

function pushSecretRefIfNamed(
  name: string,
  line: number,
  calleeText: string,
  callNode: Node,
  ctx: SecCtx,
): void {
  const kind = detectSecretKind(name)
  if (!kind) return
  ctx.out.secretRefs.push({
    file: ctx.relPath,
    line,
    varName: name,
    kind,
    callee: calleeText,
    containingSymbol: findContainingSymbol(callNode),
  })
}

// ─── Pass 2: VariableDeclaration — `const x = Math.random()` ────────────────

function scanVariableDeclarationsForWeakRandom(sf: SourceFile, ctx: SecCtx): void {
  for (const v of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = v.getInitializer()
    if (!init || !Node.isCallExpression(init)) continue
    const line = v.getStartLineNumber()
    if (ctx.isExempt(line)) continue
    if (!isMathRandomCall(init)) continue
    const nameNode = v.getNameNode()
    const varName = Node.isIdentifier(nameNode) ? nameNode.getText() : ''
    ctx.out.weakRandoms.push({
      file: ctx.relPath,
      line,
      varName,
      secretKind: detectSecretKind(varName),
      containingSymbol: findContainingSymbol(v),
    })
  }
}

function isMathRandomCall(call: Node): boolean {
  if (!Node.isCallExpression(call)) return false
  const callee = call.getExpression()
  return Node.isPropertyAccessExpression(callee)
    && callee.getExpression().getText() === 'Math'
    && callee.getName() === 'random'
}

// ─── Pass 3: ObjectLiteral — TLS unsafe options ─────────────────────────────

function scanObjectLiteralsForTlsUnsafe(sf: SourceFile, ctx: SecCtx): void {
  for (const obj of sf.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
    const line = obj.getStartLineNumber()
    if (ctx.isExempt(line)) continue
    for (const prop of obj.getProperties()) {
      if (!Node.isPropertyAssignment(prop)) continue
      const name = prop.getName()
      const init = prop.getInitializer()
      if (!init) continue
      // rejectUnauthorized: false / strictSSL: false
      if ((name === 'rejectUnauthorized' || name === 'strictSSL')
        && init.getText() === 'false') {
        ctx.out.tlsUnsafe.push({
          file: ctx.relPath,
          line,
          key: name,
          containingSymbol: findContainingSymbol(obj),
        })
      }
    }
  }
}

export interface SecurityPatternsAggregated {
  secretRefs: SecretVarRef[]
  corsConfigs: CorsConfig[]
  tlsUnsafe: TlsConfigUnsafe[]
  weakRandoms: WeakRandomCall[]
}

export async function analyzeSecurityPatterns(
  rootDir: string,
  files: string[],
  project: Project,
): Promise<SecurityPatternsAggregated> {
  const fileSet = new Set(files)
  const out: SecurityPatternsAggregated = {
    secretRefs: [], corsConfigs: [], tlsUnsafe: [], weakRandoms: [],
  }
  for (const sf of project.getSourceFiles()) {
    const rel = relativize(sf.getFilePath(), rootDir)
    if (!rel || !fileSet.has(rel)) continue
    const bundle = extractSecurityPatternsFileBundle(sf, rel)
    out.secretRefs.push(...bundle.secretRefs)
    out.corsConfigs.push(...bundle.corsConfigs)
    out.tlsUnsafe.push(...bundle.tlsUnsafe)
    out.weakRandoms.push(...bundle.weakRandoms)
  }
  // Sort all for determinism.
  const sortFn = (a: { file: string; line: number }, b: { file: string; line: number }) =>
    a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.line - b.line
  out.secretRefs.sort(sortFn)
  out.corsConfigs.sort(sortFn)
  out.tlsUnsafe.sort(sortFn)
  out.weakRandoms.sort(sortFn)
  return out
}

function relativize(absPath: string, rootDir: string): string | null {
  const normalized = absPath.replace(/\\/g, '/')
  const rootNormalized = rootDir.replace(/\\/g, '/')
  if (!normalized.startsWith(rootNormalized)) return null
  return normalized.slice(rootNormalized.length + 1)
}
