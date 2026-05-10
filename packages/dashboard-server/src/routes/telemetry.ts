import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { DashboardState } from '../state.js'

export interface TelemetryRecord {
  ts: number
  hook: string
  event: string
  file: string
  bytes: number
  tokensApprox: number
  dedupHit: boolean
  dedupAgeSec: number | null
}

export interface TelemetrySummary {
  totalEvents: number
  totalBytes: number
  totalTokensApprox: number
  dedupHits: number
  dedupSavedTokens: number
  byHook: Record<string, { count: number; tokens: number; dedupHits: number }>
  byFile: Array<{ file: string; count: number; tokens: number }>
}

async function readTelemetry(file: string, limit: number): Promise<TelemetryRecord[]> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf-8')
  } catch {
    return []
  }
  const lines = text.split('\n').filter((l) => l.trim())
  const slice = limit > 0 ? lines.slice(-limit) : lines
  const out: TelemetryRecord[] = []
  for (const line of slice) {
    try {
      out.push(JSON.parse(line) as TelemetryRecord)
    } catch {
      // skip malformed
    }
  }
  return out
}

export function summarize(records: TelemetryRecord[]): TelemetrySummary {
  const byHook: TelemetrySummary['byHook'] = {}
  const byFileMap = new Map<string, { count: number; tokens: number }>()
  let totalBytes = 0
  let totalTokens = 0
  let dedupHits = 0
  let dedupSavedTokens = 0

  // Track first-hit token cost per file so we can estimate what dedup saved.
  const firstHitTokens = new Map<string, number>()

  for (const r of records) {
    totalBytes += r.bytes
    totalTokens += r.tokensApprox
    if (r.dedupHit) {
      dedupHits++
      const baseline = firstHitTokens.get(`${r.hook}:${r.file}`)
      if (baseline) {
        dedupSavedTokens += Math.max(0, baseline - r.tokensApprox)
      }
    } else {
      firstHitTokens.set(`${r.hook}:${r.file}`, r.tokensApprox)
    }

    const h = (byHook[r.hook] ??= { count: 0, tokens: 0, dedupHits: 0 })
    h.count++
    h.tokens += r.tokensApprox
    if (r.dedupHit) h.dedupHits++

    const f = byFileMap.get(r.file) ?? { count: 0, tokens: 0 }
    f.count++
    f.tokens += r.tokensApprox
    byFileMap.set(r.file, f)
  }

  const byFile = Array.from(byFileMap.entries())
    .map(([file, v]) => ({ file, ...v }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 20)

  return {
    totalEvents: records.length,
    totalBytes,
    totalTokensApprox: totalTokens,
    dedupHits,
    dedupSavedTokens,
    byHook,
    byFile,
  }
}

export async function registerTelemetryRoutes(
  app: FastifyInstance,
  state: DashboardState,
): Promise<void> {
  const telemetryFile = path.join(state.codegraphDir, 'hook-telemetry.jsonl')

  app.get('/api/telemetry', async (req) => {
    const q = req.query as { limit?: string }
    const limit = q.limit ? parseInt(q.limit, 10) : 200
    const records = await readTelemetry(telemetryFile, limit)
    return { count: records.length, records }
  })

  app.get('/api/telemetry/summary', async () => {
    const records = await readTelemetry(telemetryFile, 0)
    return summarize(records)
  })

  // Returns the full text of a hook payload by hash.
  // Hashes are short hex (16 chars) — anything else gets rejected to
  // prevent path traversal.
  app.get('/api/hook-payload', async (req, reply) => {
    const q = req.query as { hash?: string }
    if (!q.hash || !/^[a-f0-9]{16}$/.test(q.hash)) {
      return reply.code(400).send({ error: 'invalid hash format' })
    }
    const payloadFile = path.join(state.codegraphDir, 'hook-payloads', q.hash + '.txt')
    try {
      const text = await fs.readFile(payloadFile, 'utf-8')
      reply.type('text/plain; charset=utf-8')
      return text
    } catch {
      return reply.code(404).send({ error: 'payload not found' })
    }
  })

  // Boot context — what Claude reads at session start.
  // CLAUDE-CONTEXT.md (auto-generated boot brief) lives at the project root.
  app.get('/api/boot-context', async (_req, reply) => {
    const candidates = ['CLAUDE-CONTEXT.md', 'CLAUDE.md']
    for (const name of candidates) {
      try {
        const file = path.join(state.rootDir, name)
        const text = await fs.readFile(file, 'utf-8')
        const stat = await fs.stat(file)
        return {
          file: name,
          mtime: stat.mtimeMs,
          bytes: stat.size,
          tokensApprox: Math.max(1, Math.floor(stat.size / 4)),
          content: text,
        }
      } catch {
        // try next candidate
      }
    }
    return reply.code(404).send({ error: 'no boot context found' })
  })
}
