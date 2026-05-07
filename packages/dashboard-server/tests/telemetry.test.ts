import { describe, it, expect } from 'vitest'
import { summarize, type TelemetryRecord } from '../src/routes/telemetry.js'

function rec(o: Partial<TelemetryRecord> = {}): TelemetryRecord {
  return {
    ts: 1778000000,
    hook: 'codegraph-feedback',
    event: 'PostToolUse',
    file: 'a.ts',
    bytes: 400,
    tokensApprox: 100,
    dedupHit: false,
    dedupAgeSec: null,
    ...o,
  }
}

describe('summarize', () => {
  it('totals zero on empty input', () => {
    const s = summarize([])
    expect(s.totalEvents).toBe(0)
    expect(s.totalTokensApprox).toBe(0)
    expect(s.dedupHits).toBe(0)
    expect(s.dedupSavedTokens).toBe(0)
  })

  it('aggregates events by hook', () => {
    const s = summarize([
      rec({ hook: 'adr-hook', tokensApprox: 50 }),
      rec({ hook: 'codegraph-feedback', tokensApprox: 100 }),
      rec({ hook: 'codegraph-feedback', tokensApprox: 80, dedupHit: true, dedupAgeSec: 30 }),
    ])
    expect(s.totalEvents).toBe(3)
    expect(s.totalTokensApprox).toBe(230)
    expect(s.byHook['adr-hook']).toEqual({ count: 1, tokens: 50, dedupHits: 0 })
    expect(s.byHook['codegraph-feedback']).toEqual({ count: 2, tokens: 180, dedupHits: 1 })
  })

  it('estimates dedup-saved tokens from first-hit baseline', () => {
    // First hit on a.ts costs 100. Second hit (dedup) costs 30. → saved 70.
    const s = summarize([
      rec({ file: 'a.ts', tokensApprox: 100, dedupHit: false }),
      rec({ file: 'a.ts', tokensApprox: 30, dedupHit: true, dedupAgeSec: 12 }),
    ])
    expect(s.dedupHits).toBe(1)
    expect(s.dedupSavedTokens).toBe(70)
  })

  it('does not credit savings when no first-hit baseline observed', () => {
    // Only dedup hits, no fresh hit to compare against → savings = 0
    const s = summarize([
      rec({ file: 'a.ts', tokensApprox: 30, dedupHit: true, dedupAgeSec: 12 }),
    ])
    expect(s.dedupHits).toBe(1)
    expect(s.dedupSavedTokens).toBe(0)
  })

  it('clamps negative savings to zero (dedup payload bigger than first hit)', () => {
    const s = summarize([
      rec({ file: 'a.ts', tokensApprox: 30, dedupHit: false }),
      rec({ file: 'a.ts', tokensApprox: 100, dedupHit: true, dedupAgeSec: 12 }),
    ])
    expect(s.dedupSavedTokens).toBe(0)
  })

  it('sorts byFile by tokens descending and caps to 20', () => {
    const records: TelemetryRecord[] = []
    for (let i = 0; i < 30; i++) {
      records.push(rec({ file: `f${i}.ts`, tokensApprox: i * 10 }))
    }
    const s = summarize(records)
    expect(s.byFile.length).toBe(20)
    expect(s.byFile[0].file).toBe('f29.ts')
    expect(s.byFile[0].tokens).toBe(290)
    expect(s.byFile[19].tokens).toBeLessThan(s.byFile[0].tokens)
  })

  it('separates first-hit baseline per (hook, file)', () => {
    // adr-hook on a.ts at 50 tokens; codegraph-feedback on a.ts at 200.
    // Both then dedup at 20 each → savings = 30 + 180 = 210.
    const s = summarize([
      rec({ hook: 'adr-hook', file: 'a.ts', tokensApprox: 50, dedupHit: false }),
      rec({ hook: 'codegraph-feedback', file: 'a.ts', tokensApprox: 200, dedupHit: false }),
      rec({ hook: 'adr-hook', file: 'a.ts', tokensApprox: 20, dedupHit: true, dedupAgeSec: 5 }),
      rec({ hook: 'codegraph-feedback', file: 'a.ts', tokensApprox: 20, dedupHit: true, dedupAgeSec: 5 }),
    ])
    expect(s.dedupSavedTokens).toBe(210)
  })
})
