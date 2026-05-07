import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { DashboardState } from '../state.js'

interface DetectorTiming {
  detector: string
  runs: number
  meanMs: number
  p95Ms: number
  stdDev: number
  lambda: number
}

async function readTimings(file: string): Promise<DetectorTiming[]> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf-8')
  } catch {
    return []
  }
  const out: DetectorTiming[] = []
  for (const line of text.trim().split('\n')) {
    if (!line) continue
    const cols = line.split('\t')
    if (cols.length < 6) continue
    out.push({
      detector: cols[0],
      runs: parseInt(cols[1], 10),
      meanMs: parseFloat(cols[2]),
      p95Ms: parseFloat(cols[3]),
      stdDev: parseFloat(cols[4]) / 1000,
      lambda: parseFloat(cols[5]) / 1000,
    })
  }
  return out
}

export async function registerRuntimeRoutes(
  app: FastifyInstance,
  state: DashboardState,
): Promise<void> {
  const factsDir = path.join(state.codegraphDir, 'facts-self-runtime')
  const currentFile = path.join(factsDir, 'DetectorTiming.facts')
  const baselineFile = path.join(factsDir, 'baseline/DetectorTiming.facts')

  app.get('/api/runtime/timings', async () => {
    const current = await readTimings(currentFile)
    return { count: current.length, timings: current.sort((a, b) => b.p95Ms - a.p95Ms) }
  })

  app.get('/api/runtime/diff', async () => {
    const [current, baseline] = await Promise.all([
      readTimings(currentFile),
      readTimings(baselineFile),
    ])
    const baseMap = new Map(baseline.map((t) => [t.detector, t]))
    const diffs = current.map((c) => {
      const b = baseMap.get(c.detector)
      const baseP95 = b?.p95Ms ?? 0
      const deltaPct = baseP95 > 0 ? ((c.p95Ms - baseP95) / baseP95) * 100 : null
      return {
        detector: c.detector,
        currentP95: c.p95Ms,
        baselineP95: baseP95,
        deltaPct,
        lambda: c.lambda,
      }
    })
    return { diffs: diffs.sort((a, b) => (b.deltaPct ?? -Infinity) - (a.deltaPct ?? -Infinity)) }
  })
}
