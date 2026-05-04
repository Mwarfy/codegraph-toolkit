// Test fixture pour worker_threads — fonction CPU-bound utilisée par
// parallel-workers.test.ts. Simule un extractor real (regex scan, hash).

export function heavyExtract(input) {
  // CPU work : ~10ms par appel
  let sum = 0
  for (let i = 0; i < 200_000; i++) {
    sum += Math.sqrt(i * input.value) | 0
  }
  return { id: input.id, sum, ts: Date.now() }
}

export function trivialExtract(input) {
  return { id: input.id, value: input.value * 2 }
}
