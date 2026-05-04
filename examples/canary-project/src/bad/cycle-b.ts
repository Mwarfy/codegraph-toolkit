import { compute } from './cycle-a.js'

export function helper(n: number): number {
  if (n <= 0) return 1
  return compute(n - 1) * 2
}
