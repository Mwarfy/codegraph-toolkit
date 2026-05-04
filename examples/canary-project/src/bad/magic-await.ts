// VIOLATION #7 — magic numbers + await dans loop + allocation dans loop.
//
// Détection attendue :
//   - MagicNumber ≥ 2 (3600, 86400)
//   - AwaitInLoop ≥ 1
//   - AllocationInLoop ≥ 1

export async function processItems(items: number[]): Promise<number[]> {
  const out: number[] = []
  for (const item of items) {
    // allocation in loop : new Date à chaque itération
    const ts = new Date()
    // await in loop : sequentiel au lieu de Promise.all
    await new Promise((r) => setTimeout(r, 10))
    // magic numbers
    out.push(item * 3600 + 86400 + ts.getTime())
  }
  return out
}
