/**
 * Tests pour le cœur I/O de session-reader : `readSessionsFromDirs`.
 * Vérifie l'extraction des tool_use, le cutoff de récence, le comptage des
 * erreurs de parse, le sessionCount distinct, l'ignore des non-.jsonl, et le
 * déterminisme de l'ordre des toolUses (concat dans l'ordre des fichiers).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { readSessionsFromDirs } from '../src/discover/session-reader.js'

/** Event assistant JSONL avec un seul tool_use. */
function assistantEvent(opts: {
  sessionId: string
  tool: string
  timestamp?: string
  input?: Record<string, unknown>
}): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: opts.sessionId,
    timestamp: opts.timestamp ?? new Date().toISOString(),
    cwd: '/repo',
    gitBranch: 'main',
    message: { content: [{ type: 'tool_use', name: opts.tool, input: opts.input ?? {} }] },
  })
}

describe('session-reader — readSessionsFromDirs', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sess-reader-'))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('extrait les tool_use events d\'un fichier .jsonl', async () => {
    await fs.writeFile(
      path.join(dir, 's1.jsonl'),
      [
        assistantEvent({ sessionId: 'a', tool: 'Read', input: { file_path: '/repo/x.ts' } }),
        assistantEvent({ sessionId: 'a', tool: 'Edit' }),
      ].join('\n'),
    )

    const r = await readSessionsFromDirs([dir], {})
    expect(r.toolUses.map((t) => t.tool)).toEqual(['Read', 'Edit'])
    expect(r.toolUses[0].input).toEqual({ file_path: '/repo/x.ts' })
    expect(r.sessionCount).toBe(1)
    expect(r.parseErrors).toBe(0)
  })

  it('filtre les events plus vieux que sinceDays', async () => {
    await fs.writeFile(
      path.join(dir, 's1.jsonl'),
      [
        assistantEvent({ sessionId: 'a', tool: 'Read', timestamp: '2020-01-01T00:00:00.000Z' }),
        assistantEvent({ sessionId: 'a', tool: 'Edit' }), // récent
      ].join('\n'),
    )

    const r = await readSessionsFromDirs([dir], { sinceDays: 30 })
    expect(r.toolUses.map((t) => t.tool)).toEqual(['Edit'])
  })

  it('compte les lignes corrompues sans throw', async () => {
    await fs.writeFile(
      path.join(dir, 's1.jsonl'),
      [assistantEvent({ sessionId: 'a', tool: 'Read' }), 'NOT_JSON', ''].join('\n'),
    )

    const r = await readSessionsFromDirs([dir], {})
    expect(r.parseErrors).toBe(1)
    expect(r.lineCount).toBe(2) // 2 lignes non vides
    expect(r.toolUses).toHaveLength(1)
  })

  it('sessionCount = nombre de sessionId distincts', async () => {
    await fs.writeFile(
      path.join(dir, 's1.jsonl'),
      [
        assistantEvent({ sessionId: 'a', tool: 'Read' }),
        assistantEvent({ sessionId: 'b', tool: 'Edit' }),
        assistantEvent({ sessionId: 'a', tool: 'Bash' }),
      ].join('\n'),
    )

    const r = await readSessionsFromDirs([dir], {})
    expect(r.sessionCount).toBe(2)
  })

  it('ignore les fichiers non-.jsonl', async () => {
    await fs.writeFile(path.join(dir, 'notes.txt'), 'NOT_JSON\n')
    await fs.writeFile(path.join(dir, 's1.jsonl'), assistantEvent({ sessionId: 'a', tool: 'Read' }))

    const r = await readSessionsFromDirs([dir], {})
    expect(r.toolUses).toHaveLength(1)
    expect(r.parseErrors).toBe(0)
  })

  it('dir manquant est skippé sans throw', async () => {
    const r = await readSessionsFromDirs([path.join(dir, 'does-not-exist')], {})
    expect(r.toolUses).toHaveLength(0)
    expect(r.sessionCount).toBe(0)
  })

  it('préserve l\'ordre des toolUses (déterminisme inter-dirs)', async () => {
    const dirA = path.join(dir, 'A')
    const dirB = path.join(dir, 'B')
    await fs.mkdir(dirA)
    await fs.mkdir(dirB)
    await fs.writeFile(path.join(dirA, 's.jsonl'), assistantEvent({ sessionId: 'a', tool: 'Read' }))
    await fs.writeFile(path.join(dirB, 's.jsonl'), assistantEvent({ sessionId: 'b', tool: 'Bash' }))

    const r1 = await readSessionsFromDirs([dirA, dirB], {})
    const r2 = await readSessionsFromDirs([dirA, dirB], {})
    expect(r1.toolUses.map((t) => t.tool)).toEqual(['Read', 'Bash'])
    expect(r2.toolUses.map((t) => t.tool)).toEqual(r1.toolUses.map((t) => t.tool))
  })
})
