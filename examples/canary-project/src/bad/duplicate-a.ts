// VIOLATION #12 (a/b) — signature near-duplicate : 2 fonctions presque identiques.
//
// Détection attendue : SignatureNearDuplicate ≥ 1.

export function processOrder(items: number[], discount: number): number {
  let total = 0
  for (const item of items) {
    total += item
  }
  return total * (1 - discount)
}
