import type { SourceFile } from 'ts-morph'
import type { ExemptionLineFact } from './types.js'

const EXEMPTION_MARKERS = new Set([
  'dead-code-ok',
  'magic-numbers-ok',
  'complexity-ok',
  'secret-ok',
  'eval-ok',
  'crypto-ok',
  'const-expr-ok',
  'resource-balance-ok',
  'security-ok',
  'drift-ok',
  'regex-ok',
  'catch-ok',
  'await-ok',
  'alloc-ok',
])

export function visitExemptionMarkers(
  sf: SourceFile,
  relPath: string,
  out: ExemptionLineFact[],
): void {
  const fullText = sf.getFullText()
  const lines = fullText.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    const m = /^\/\/\s*([a-z][\w-]+)(?:[:\s]|$)/.exec(trimmed)
    if (!m) continue
    const marker = m[1]
    if (!EXEMPTION_MARKERS.has(marker)) continue
    let target = -1
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim()
      if (t === '') continue
      if (t.startsWith('//')) continue
      target = j + 1
      break
    }
    if (target === -1) continue
    out.push({ file: relPath, line: target, marker })
  }
}
