// Pair de duplicate-a : presque identique, devrait être unifié.
export function processInvoice(items: number[], discount: number): number {
  let total = 0
  for (const item of items) {
    total += item
  }
  return total * (1 - discount)
}
