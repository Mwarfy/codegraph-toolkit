/**
 * Tests pour le memory store (Phase 4 axe 3).
 *
 * Override HOME pour rediriger `~/.codegraph-toolkit/memory/` vers un tmpdir
 * isolé — les tests n'écrivent jamais sur le vrai filesystem utilisateur.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  memoryPathFor, memoryDir,
  loadMemoryRaw, addEntry, markObsolete, deleteEntry, recall, entryId,
} from '../src/memory/store.js'

let tmpHome: string
let originalHome: string | undefined
const projectA = '/tmp/fake-project-a'
const projectB = '/tmp/fake-project-b'

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codegraph-memory-home-'))
  originalHome = process.env.HOME
  process.env.HOME = tmpHome
})

afterEach(async () => {
  if (originalHome !== undefined) process.env.HOME = originalHome
  else delete process.env.HOME
  await fs.rm(tmpHome, { recursive: true, force: true })
})

describe('memory store — paths', () => {
  it('memoryDir respecte HOME', () => {
    expect(memoryDir()).toBe(path.join(tmpHome, '.codegraph-toolkit', 'memory'))
  })

  it('memoryPathFor : basename + hash 8 chars', () => {
    const p = memoryPathFor('/tmp/fake-project-a')
    expect(p).toMatch(/fake-project-a-[a-f0-9]{8}\.json$/)
  })

  it('memoryPathFor : 2 projets différents → 2 paths différents', () => {
    expect(memoryPathFor(projectA)).not.toBe(memoryPathFor(projectB))
  })

  it('memoryPathFor : même path absolu → même slug (déterministe)', () => {
    expect(memoryPathFor(projectA)).toBe(memoryPathFor(projectA))
  })

  it('memoryPathFor : sanitize les caractères spéciaux dans le basename', () => {
    const p = memoryPathFor('/tmp/weird name @ project!')
    // espaces et caractères spéciaux remplacés par _
    expect(p).toMatch(/weird_name___project_-[a-f0-9]{8}\.json$/)
  })
})

describe('memory store — load empty', () => {
  it('retourne un store vide si le fichier n\'existe pas', async () => {
    const store = await loadMemoryRaw(projectA)
    expect(store.version).toBe(1)
    expect(store.entries).toEqual([])
    expect(store.project).toBe('fake-project-a')
  })

  it('ne crée PAS le fichier au load (lecture pure)', async () => {
    await loadMemoryRaw(projectA)
    const exists = await fs.access(memoryPathFor(projectA)).then(() => true).catch(() => false)
    expect(exists).toBe(false)
  })
})

describe('memory store — addEntry', () => {
  it('crée et persiste une entrée', async () => {
    const e = await addEntry(projectA, {
      kind: 'false-positive',
      fingerprint: 'truth-points:items',
      reason: 'Drizzle column false-positive',
      scope: { detector: 'truth-points', file: 'src/db/schema.ts' },
    })
    expect(e.id).toMatch(/^[a-f0-9]{12}$/)
    expect(e.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(e.obsoleteAt).toBeNull()

    const reloaded = await loadMemoryRaw(projectA)
    expect(reloaded.entries).toHaveLength(1)
    expect(reloaded.entries[0].fingerprint).toBe('truth-points:items')
  })

  it('addEntry est idempotent — même (kind, fingerprint) update au lieu de doublonner', async () => {
    await addEntry(projectA, {
      kind: 'false-positive',
      fingerprint: 'X',
      reason: 'first',
    })
    await addEntry(projectA, {
      kind: 'false-positive',
      fingerprint: 'X',
      reason: 'second',
    })
    const store = await loadMemoryRaw(projectA)
    expect(store.entries).toHaveLength(1)
    expect(store.entries[0].reason).toBe('second')
  })

  it('addEntry resurrect une entrée obsolète', async () => {
    const e = await addEntry(projectA, {
      kind: 'false-positive',
      fingerprint: 'X',
      reason: 'one',
    })
    await markObsolete(projectA, e.id)
    let store = await loadMemoryRaw(projectA)
    expect(store.entries[0].obsoleteAt).not.toBeNull()

    await addEntry(projectA, {
      kind: 'false-positive',
      fingerprint: 'X',
      reason: 'resurrected',
    })
    store = await loadMemoryRaw(projectA)
    expect(store.entries[0].obsoleteAt).toBeNull()
    expect(store.entries[0].reason).toBe('resurrected')
  })

  it('entryId est stable pour les mêmes inputs', () => {
    expect(entryId('false-positive', 'X')).toBe(entryId('false-positive', 'X'))
    expect(entryId('false-positive', 'X')).not.toBe(entryId('decision', 'X'))
    expect(entryId('false-positive', 'X')).not.toBe(entryId('false-positive', 'Y'))
  })

  it('isolation entre projets — addEntry projectA n\'apparaît pas dans projectB', async () => {
    await addEntry(projectA, { kind: 'decision', fingerprint: 'A-only', reason: 'A' })
    const storeB = await loadMemoryRaw(projectB)
    expect(storeB.entries).toEqual([])
  })
})

describe('memory store — markObsolete / deleteEntry', () => {
  it('markObsolete pose obsoleteAt mais garde l\'entry', async () => {
    const e = await addEntry(projectA, {
      kind: 'incident',
      fingerprint: 'sched:race-2026-03',
      reason: 'fixed by ADR-018',
    })
    const ok = await markObsolete(projectA, e.id)
    expect(ok).toBe(true)

    const store = await loadMemoryRaw(projectA)
    expect(store.entries).toHaveLength(1)
    expect(store.entries[0].obsoleteAt).not.toBeNull()
  })

  it('markObsolete return false si id inconnu', async () => {
    const ok = await markObsolete(projectA, 'nonexistent-id')
    expect(ok).toBe(false)
  })

  it('deleteEntry supprime durement', async () => {
    const e = await addEntry(projectA, {
      kind: 'decision',
      fingerprint: 'X',
      reason: 'x',
    })
    const ok = await deleteEntry(projectA, e.id)
    expect(ok).toBe(true)
    const store = await loadMemoryRaw(projectA)
    expect(store.entries).toEqual([])
  })
})

describe('memory store — recall', () => {
  beforeEach(async () => {
    await addEntry(projectA, {
      kind: 'false-positive',
      fingerprint: 'tp:items',
      reason: 'Drizzle FP',
      scope: { detector: 'truth-points', file: 'src/db/schema.ts' },
    })
    await addEntry(projectA, {
      kind: 'decision',
      fingerprint: 'no-redis-for-x',
      reason: 'Decided 2026-04-15',
      scope: { file: 'src/kernel/foo.ts' },
    })
    const obsoleted = await addEntry(projectA, {
      kind: 'incident',
      fingerprint: 'sched:race',
      reason: 'fixed',
    })
    await markObsolete(projectA, obsoleted.id)
  })

  it('recall sans scope retourne les non-obsolètes', async () => {
    const results = await recall(projectA)
    expect(results).toHaveLength(2)
    expect(results.map((e) => e.kind).sort()).toEqual(['decision', 'false-positive'])
  })

  it('recall avec includeObsolete=true retourne TOUT', async () => {
    const results = await recall(projectA, { includeObsolete: true })
    expect(results).toHaveLength(3)
  })

  it('recall avec kind filtre exactement', async () => {
    const results = await recall(projectA, { kind: 'false-positive' })
    expect(results).toHaveLength(1)
    expect(results[0].fingerprint).toBe('tp:items')
  })

  it('recall avec file filtre par scope.file', async () => {
    const results = await recall(projectA, { file: 'src/kernel/foo.ts' })
    expect(results).toHaveLength(1)
    expect(results[0].kind).toBe('decision')
  })

  it('recall avec detector filtre par scope.detector', async () => {
    const results = await recall(projectA, { detector: 'truth-points' })
    expect(results).toHaveLength(1)
    expect(results[0].fingerprint).toBe('tp:items')
  })

  it('recall combine kind + file (AND)', async () => {
    const r = await recall(projectA, { kind: 'decision', file: 'src/kernel/foo.ts' })
    expect(r).toHaveLength(1)
    const r2 = await recall(projectA, { kind: 'false-positive', file: 'src/kernel/foo.ts' })
    expect(r2).toHaveLength(0)
  })
})

describe('memory store — corruption resilience', () => {
  it('skip les entries malformées au lieu de tout perdre', async () => {
    // Crée un store avec 1 valide + 2 corrompues
    const file = memoryPathFor(projectA)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const corrupted = {
      version: 1,
      project: 'fake',
      rootDir: '/tmp/fake-project-a',
      lastUpdated: '2026-04-30T00:00:00.000Z',
      entries: [
        { id: 'good', kind: 'decision', fingerprint: 'X', reason: 'r', addedAt: '2026-04-30T00:00:00.000Z', obsoleteAt: null },
        { id: 'bad-no-kind', fingerprint: 'X', reason: 'r', addedAt: '...' },
        { kind: 'badkind', fingerprint: 'X', reason: 'r', id: 'bad-kind', addedAt: '...' },
      ],
    }
    await fs.writeFile(file, JSON.stringify(corrupted))

    const store = await loadMemoryRaw(projectA)
    expect(store.entries).toHaveLength(1)
    expect(store.entries[0].id).toBe('good')
  })

  it('throw si version != 1', async () => {
    const file = memoryPathFor(projectA)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ version: 99, entries: [] }))
    await expect(loadMemoryRaw(projectA)).rejects.toThrow(/unsupported version/)
  })
})
