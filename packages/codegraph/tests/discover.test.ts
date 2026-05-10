/**
 * Tests pour `discover/classifier.ts` — pas d'I/O, juste la logique de
 * classification sur fixtures in-memory.
 */

import { describe, expect, it } from 'vitest'
import { classify, type DiscoverReport } from '../src/discover/classifier.js'
import type { ToolUse } from '../src/discover/session-reader.js'

const SNAPSHOT = {
  rootDir: '/repo',
  nodes: [
    { id: 'src/registry.ts', type: 'file' },
    { id: 'src/leaf.ts', type: 'file' },
    { id: 'src/other.ts', type: 'file' },
  ],
  edges: [
    // registry.ts gets in-degree 3 (top hub) — stem ≥4 chars pour grep-match
    { from: 'src/a.ts', to: 'src/registry.ts' },
    { from: 'src/b.ts', to: 'src/registry.ts' },
    { from: 'src/c.ts', to: 'src/registry.ts' },
    // leaf.ts gets in-degree 1
    { from: 'src/a.ts', to: 'src/leaf.ts' },
  ],
}

function tu(tool: string, input: Record<string, unknown>, sessionId = 's1'): ToolUse {
  return { sessionId, timestamp: new Date().toISOString(), cwd: '/repo', tool, input }
}

describe('discover.classify', () => {
  it('compte les Read/Edit/Grep/Bash globaux', () => {
    const uses: ToolUse[] = [
      tu('Read', { file_path: '/repo/src/registry.ts' }),
      tu('Edit', { file_path: '/repo/src/leaf.ts' }),
      tu('Grep', { pattern: 'foo', path: '/repo/src' }),
      tu('Bash', { command: 'ls' }),
      tu('Bash', { command: 'git status' }),
    ]
    const r = classify(uses, SNAPSHOT)
    expect(r.totals.reads).toBe(1)
    expect(r.totals.edits).toBe(1)
    expect(r.totals.greps).toBe(1)
    expect(r.totals.bashCalls).toBe(2)
    expect(r.totals.sessions).toBe(1)
  })

  it('détecte hub-reads (Read sur top hub)', () => {
    const uses: ToolUse[] = [
      tu('Read', { file_path: '/repo/src/registry.ts' }),
      tu('Read', { file_path: '/repo/src/registry.ts' }),
      tu('Read', { file_path: '/repo/src/leaf.ts' }),
    ]
    const r = classify(uses, SNAPSHOT)
    expect(r.hubReads).toHaveLength(2)
    const hub = r.hubReads.find((h) => h.file === 'src/registry.ts')!
    expect(hub.reads).toBe(2)
    expect(hub.hubRank).toBe(1)
    expect(hub.inDegree).toBe(3)
  })

  it('détecte repeat-reads dans une même session (≥3)', () => {
    const uses: ToolUse[] = [
      tu('Read', { file_path: '/repo/src/leaf.ts' }, 's1'),
      tu('Read', { file_path: '/repo/src/leaf.ts' }, 's1'),
      tu('Read', { file_path: '/repo/src/leaf.ts' }, 's1'),
      tu('Read', { file_path: '/repo/src/other.ts' }, 's1'), // only 1× → pas repeat
      tu('Read', { file_path: '/repo/src/leaf.ts' }, 's2'), // autre session → pas cumulé
    ]
    const r = classify(uses, SNAPSHOT)
    expect(r.repeatReads).toHaveLength(1)
    expect(r.repeatReads[0]).toEqual({ sessionId: 's1', file: 'src/leaf.ts', reads: 3 })
  })

  it('ignore les paths hors rootDir', () => {
    const uses: ToolUse[] = [
      tu('Read', { file_path: '/other-project/foo.ts' }),
      tu('Read', { file_path: '/repo/src/registry.ts' }),
    ]
    const r = classify(uses, SNAPSHOT)
    expect(r.totals.reads).toBe(1) // /other-project filtered out
  })

  it('détecte grep-on-hub-symbol quand le pattern matche un nom de hub', () => {
    const uses: ToolUse[] = [
      tu('Grep', { pattern: 'registry', path: '/repo' }), // matche src/registry.ts (stem='hub')
      tu('Grep', { pattern: 'registry', path: '/repo' }),
      tu('Grep', { pattern: 'xyz', path: '/repo' }), // ne matche aucun hub
    ]
    const r = classify(uses, SNAPSHOT)
    expect(r.grepOnHubSymbols).toHaveLength(1)
    expect(r.grepOnHubSymbols[0]).toMatchObject({
      pattern: 'registry',
      matchedHubFile: 'src/registry.ts',
      count: 2,
    })
  })

  it('retourne un report vide pour une liste vide', () => {
    const r: DiscoverReport = classify([], SNAPSHOT)
    expect(r.totals.toolUses).toBe(0)
    expect(r.hubReads).toEqual([])
    expect(r.repeatReads).toEqual([])
    expect(r.grepOnHubSymbols).toEqual([])
  })
})
