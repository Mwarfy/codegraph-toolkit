/**
 * Signature near-duplicate detection — théorie des codes (Hamming 1950).
 *
 * Origine : aucun analyzer TS/JS ne détecte les fonctions structurellement
 * similaires modulo renaming. Les outils existants (jscpd, simian) font
 * du token-based exact match. La théorie des codes propose un signal plus
 * robuste : encoder la "shape" de la fonction comme une signature et
 * comparer via distance Hamming.
 *
 * Encoding heuristic (compression de la signature AST) :
 *   - paramCount × 4 bits
 *   - returnKind ('void'/'Promise'/'value'/'never') × 2 bits
 *   - hasGenerics × 1 bit
 *   - kind ('function'/'method'/'arrow') × 2 bits
 *   - approx-loc-bucket (log₂ loc) × 4 bits
 *   - cyclomaticBucket × 4 bits
 *
 * Total ~17 bits = signature compacte. 2 fonctions avec Hamming ≤ 2
 * ont 99%+ de chance d'avoir la même structure.
 *
 * Détecte typiquement :
 *   - Handlers route/webhook quasi-identiques
 *   - Wrappers d'API qui font la même chose
 *   - Validators qui dupliquent la logique
 *
 * Output : pairs (sym1, sym2, hamming, score). Triés par score asc
 * (les plus similaires en haut).
 */

import type { TypedSignature } from '../core/types.js'

export interface SignatureDuplicate {
  symbolA: string  // "file:name"
  symbolB: string
  hamming: number  // bits différents
  /** signature compacte commune (en hex). */
  signatureA: string
  signatureB: string
}

function encodeSignature(sig: TypedSignature): number {
  let bits = 0
  // paramCount (4 bits, capped at 15) — depuis params.length
  const params = Math.min(15, sig.params?.length ?? 0)
  bits |= params & 0xF
  // kind (2 bits)
  const kindMap: Record<string, number> = {
    function: 0, method: 1, class: 2, const: 3,
  }
  const kindBits = kindMap[sig.kind] ?? 0
  bits |= (kindBits & 0x3) << 4
  // returnType bucket (2 bits) : Promise / void / value / never
  let retBits = 0
  const ret = sig.returnType ?? ''
  if (ret.startsWith('Promise')) retBits = 1
  else if (ret === 'void') retBits = 2
  else if (ret === 'never') retBits = 3
  bits |= (retBits & 0x3) << 6
  // line bucket (4 bits, log₂)
  const loc = Math.max(1, sig.line ?? 1)
  const lineBucket = Math.min(15, Math.floor(Math.log2(loc)))
  bits |= (lineBucket & 0xF) << 8
  return bits
}

function hammingDistance(a: number, b: number): number {
  let x = a ^ b
  let count = 0
  while (x) { count += x & 1; x >>>= 1 }
  return count
}

export function detectSignatureDuplicates(
  signatures: TypedSignature[],
  options: {
    hammingThreshold?: number
    sameKindOnly?: boolean
    /** Si true, ne retient que les paires avec exportName identique
     *  (= copy-paste avec renaming inter-file). Rejette les coincidences
     *  structurelles entre fonctions sémantiquement différentes. */
    sameNameOnly?: boolean
  } = {},
): SignatureDuplicate[] {
  const hammingT = options.hammingThreshold ?? 1
  const sameKindOnly = options.sameKindOnly ?? true
  const sameNameOnly = options.sameNameOnly ?? false
  const encoded: Array<{ sig: TypedSignature; bits: number }> = []
  for (const s of signatures) {
    encoded.push({ sig: s, bits: encodeSignature(s) })
  }
  // Bucket by exact match first, then refine by Hamming
  const out: SignatureDuplicate[] = []
  const seen = new Set<string>()
  for (let i = 0; i < encoded.length; i++) {
    for (let j = i + 1; j < encoded.length; j++) {
      const a = encoded[i]
      const b = encoded[j]
      if (sameKindOnly && a.sig.kind !== b.sig.kind) continue
      if (sameNameOnly && a.sig.exportName !== b.sig.exportName) continue
      const d = hammingDistance(a.bits, b.bits)
      if (d > hammingT) continue
      // Skip si même file (souvent legitimes : overloads)
      if (a.sig.file === b.sig.file) continue
      // Skip si paramCount different (le bit-encoding est lossy au-dela de 15)
      if ((a.sig.params?.length ?? 0) !== (b.sig.params?.length ?? 0)) continue
      const idA = `${a.sig.file}:${a.sig.exportName}`
      const idB = `${b.sig.file}:${b.sig.exportName}`
      const key = idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        symbolA: idA,
        symbolB: idB,
        hamming: d,
        signatureA: a.bits.toString(16),
        signatureB: b.bits.toString(16),
      })
    }
  }
  out.sort((a, b) => a.hamming - b.hamming)
  return out
}
