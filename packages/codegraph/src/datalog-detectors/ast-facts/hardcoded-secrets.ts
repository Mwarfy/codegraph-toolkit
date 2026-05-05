import { type SourceFile, Node, SyntaxKind } from 'ts-morph'
import type { HardcodedSecretCandidateFact } from './types.js'

const SECRET_SUSPICIOUS_NAME_RE =
  /\b(?:api[_-]?key|secret|token|password|passwd|pwd|credential|auth|bearer|access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret)\b/i

const SECRET_KNOWN_PREFIX_RE =
  /^(?:sk-[A-Za-z0-9]{20,}|sk_(?:test|live)_[A-Za-z0-9]{20,}|pk_(?:test|live)_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|xox[bps]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|ya29\.[0-9A-Za-z_-]{20,})/

const SECRET_MIN_LENGTH = 20
const SECRET_MIN_ENTROPY_X1000 = 4_000

function shannonEntropyX1000(s: string): number {
  if (s.length === 0) return 0
  const freq = new Map<string, number>()
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1)
  let h = 0
  for (const c of freq.values()) {
    const p = c / s.length
    h -= p * Math.log2(p)
  }
  return Math.trunc(h * 1000)
}

function findSecretContext(node: Node): string | null {
  const parent = node.getParent()
  if (!parent) return null
  if (Node.isVariableDeclaration(parent)) return parent.getName()
  if (Node.isPropertyAssignment(parent)) {
    return parent.getName().replace(/^['"]|['"]$/g, '')
  }
  if (Node.isBinaryExpression(parent)) {
    const lhs = parent.getLeft()
    if (Node.isPropertyAccessExpression(lhs)) return lhs.getName()
  }
  return null
}

export function visitHardcodedSecretCandidates(
  sf: SourceFile,
  relPath: string,
  out: HardcodedSecretCandidateFact[],
): void {
  for (const lit of sf.getDescendantsOfKind(SyntaxKind.StringLiteral)) {
    const value = lit.getLiteralText()
    if (value.length < SECRET_MIN_LENGTH) continue

    const context = findSecretContext(lit)
    let trigger: 'name' | 'pattern' | null = null
    if (SECRET_KNOWN_PREFIX_RE.test(value)) {
      trigger = 'pattern'
    } else if (context && SECRET_SUSPICIOUS_NAME_RE.test(context)) {
      trigger = 'name'
    }
    if (!trigger) continue

    const entX1000 = shannonEntropyX1000(value)
    if (trigger === 'name' && entX1000 < SECRET_MIN_ENTROPY_X1000) continue

    out.push({
      file: relPath,
      line: lit.getStartLineNumber(),
      varOrPropName: context ?? '',
      sample: value.slice(0, Math.min(8, value.length)) + '…',
      entropyX1000: entX1000,
      length: value.length,
      trigger,
    })
  }
}
