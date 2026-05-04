// VIOLATION #2 — cycle direct : cycle-a ↔ cycle-b
//
// Détection attendue : 1 cycle de taille 2 dans snapshot.cycles.

import { helper } from './cycle-b.js'

export function compute(n: number): number {
  if (n <= 0) return 0
  return helper(n - 1) + n
}
