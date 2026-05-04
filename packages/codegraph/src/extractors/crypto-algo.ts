/**
 * Crypto algorithm calls — detecteur deterministe AST (Phase 5 Tier 16).
 *
 * Capture les call-sites d'API crypto :
 *   - `crypto.createHash('md5')` -> CryptoCall(file, line, "createHash", "md5")
 *   - `crypto.createCipher('des', key)`
 *   - `crypto.createCipheriv('aes-128-ecb', key, iv)`
 *   - `crypto.createHmac('sha1', key)`
 *   - `crypto.pbkdf2(pwd, salt, 1000, 32, 'sha1', cb)`
 *   - `crypto.scrypt(pwd, salt, 32, cb)`
 *
 * Pourquoi : les CWE-327 (broken/risky crypto) demandent de connaitre
 * l'ALGO utilise, pas juste la fonction. cwe-327-weak-crypto.dl V1
 * detecte uniquement par nom de callee (createHash flaggue meme avec
 * sha256). Cette extraction permet une rule precise (algo-aware).
 *
 * Algos faibles connus (info logged ici, decision de blacklist dans la
 * rule Datalog cote consumer) :
 *   - hash : md5, md4, md2, sha1, sha-1, ripemd128
 *   - cipher mode : ecb (electronic-code-book — pas IV-bound)
 *   - cipher : des, des-ede, rc4, rc2
 *   - kdf : pbkdf2 < 100k iterations (info iter only — extractor capture)
 *
 * Pattern exempt : `// crypto-ok: <reason>` ligne precedente.
 */

import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import { type Project, type SourceFile, Node, SyntaxKind } from 'ts-morph'
import { findContainingSymbol, makeIsExemptForMarker } from './_shared/ast-helpers.js'
import { runPerSourceFileExtractor } from '../parallel/per-source-file-extractor.js'

export interface CryptoCall {
  file: string
  line: number
  /** Method name : createHash / createCipher / createCipheriv / createHmac / pbkdf2 / scrypt */
  fn: string
  /** Algo string literal first arg (lowercased). '' si non-literal (variable). */
  algo: string
  containingSymbol: string
}

const TEST_FILE_RE = /(\.test\.tsx?|\.spec\.tsx?|(^|\/)tests?\/|(^|\/)fixtures?\/)/

const CRYPTO_METHODS = new Set([
  'createHash', 'createCipher', 'createCipheriv', 'createHmac',
  'createDecipher', 'createDecipheriv',
  'pbkdf2', 'pbkdf2Sync', 'scrypt', 'scryptSync',
])

const CRYPTO_OBJECT_RE = /^(crypto|node:crypto)$/i

export interface CryptoCallsFileBundle {
  calls: CryptoCall[]
}

export function extractCryptoCallsFileBundle(
  sf: SourceFile,
  relPath: string,
): CryptoCallsFileBundle {
  if (TEST_FILE_RE.test(relPath)) return { calls: [] }
  const calls: CryptoCall[] = []

  const isExempt = makeIsExemptForMarker(sf, 'crypto-ok')

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression()
    if (!Node.isPropertyAccessExpression(callee)) continue
    const methodName = callee.getName()
    if (!CRYPTO_METHODS.has(methodName)) continue

    // Filter on object: crypto.X or randomly named import (best effort).
    const obj = callee.getExpression()
    const objText = obj.getText()
    if (!CRYPTO_OBJECT_RE.test(objText.split('.').pop() ?? '')) {
      // Allow other object names (user might `import { createHash } from
      // 'crypto'` or alias) — but only if method name is unambiguous.
      // Skip for now if object doesn't match — too noisy otherwise.
      if (objText !== 'crypto') continue
    }

    const line = call.getStartLineNumber()
    if (isExempt(line)) continue

    const args = call.getArguments()
    let algo = ''
    if (args.length > 0) {
      const arg0 = args[0]
      if (Node.isStringLiteral(arg0) || Node.isNoSubstitutionTemplateLiteral(arg0)) {
        algo = arg0.getLiteralValue().toLowerCase()
      }
    }

    calls.push({
      file: relPath,
      line,
      fn: methodName,
      algo,
      containingSymbol: findContainingSymbol(call),
    })
  }

  return { calls }
}

/**
 * Worker entrypoint Phase γ.2.
 */
export function extractCryptoCallsForWorker(sf: SourceFile, relPath: string): CryptoCall[] {
  return extractCryptoCallsFileBundle(sf, relPath).calls
}

const CRYPTO_ALGO_WORKER_MODULE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'crypto-algo.js',
)

export async function analyzeCryptoCalls(
  rootDir: string,
  files: string[],
  project: Project,
): Promise<CryptoCall[]> {
  const r = await runPerSourceFileExtractor<CryptoCallsFileBundle, CryptoCall>({
    project,
    files,
    rootDir,
    extractor: extractCryptoCallsFileBundle,
    selectItems: (b) => b.calls,
    sortKey: (c) => `${c.file}:${String(c.line).padStart(8, '0')}`,
    workerModule: CRYPTO_ALGO_WORKER_MODULE,
    workerExport: 'extractCryptoCallsForWorker',
  })
  return r.items
}

function relativize(absPath: string, rootDir: string): string | null {
  const normalized = absPath.replace(/\\/g, '/')
  const rootNormalized = rootDir.replace(/\\/g, '/')
  if (!normalized.startsWith(rootNormalized)) return null
  return normalized.slice(rootNormalized.length + 1)
}
