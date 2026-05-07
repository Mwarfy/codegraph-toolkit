import { describe, it, expect } from 'vitest'
import { parseSnapshotName } from '../src/routes/snapshot.js'

describe('parseSnapshotName', () => {
  it('parses a valid snapshot filename', () => {
    const r = parseSnapshotName('snapshot-2026-05-06T20-25-01-e9b880a.json')
    expect(r).toEqual({
      ts: '2026-05-06T20-25-01',
      sha: 'e9b880a',
      isoDate: '2026-05-06T20:25:01Z',
    })
  })

  it('returns null for snapshot-live.json', () => {
    expect(parseSnapshotName('snapshot-live.json')).toBeNull()
  })

  it('returns null for arbitrary filenames', () => {
    expect(parseSnapshotName('foo.json')).toBeNull()
    expect(parseSnapshotName('snapshot.json')).toBeNull()
    expect(parseSnapshotName('not-a-snapshot.json')).toBeNull()
  })

  it('returns null when sha contains uppercase or non-hex', () => {
    expect(parseSnapshotName('snapshot-2026-05-06T20-25-01-DEADBEEF.json')).toBeNull()
    expect(parseSnapshotName('snapshot-2026-05-06T20-25-01-zzzzzzz.json')).toBeNull()
  })

  it('handles short and long sha (any hex length)', () => {
    expect(parseSnapshotName('snapshot-2026-05-06T20-25-01-abc.json')?.sha).toBe('abc')
    expect(parseSnapshotName('snapshot-2026-05-06T20-25-01-abcdef0123456789abcdef0123456789abcdef01.json')?.sha)
      .toBe('abcdef0123456789abcdef0123456789abcdef01')
  })
})
