import { describe, it, expect } from 'vitest'
import {
  fromCycles,
  fromBarrels,
  fromOrphans,
  fromLongFunctions,
  fromDriftSignals,
  type SnapshotShape,
} from '../src/routes/tensions.js'

describe('tension builders', () => {
  describe('fromCycles', () => {
    it('returns one tension per cycle', () => {
      const data: SnapshotShape = { cycles: [{ files: ['a.ts', 'b.ts'] }, { files: ['c.ts', 'd.ts', 'e.ts'] }] }
      const out = fromCycles(data)
      expect(out).toHaveLength(2)
      expect(out[0].kind).toBe('cycle')
      expect(out[0].target).toBe('a.ts → b.ts')
      expect(out[1].detail).toBe('cycle de 3 fichiers')
    })

    it('returns empty array when no cycles', () => {
      expect(fromCycles({})).toEqual([])
    })
  })

  describe('fromBarrels', () => {
    it('only emits low-value barrels', () => {
      const data: SnapshotShape = {
        barrels: [
          { file: 'lib/index.ts', reExportCount: 12, consumerCount: 0, lowValue: true },
          { file: 'core/index.ts', reExportCount: 4, consumerCount: 8, lowValue: false },
          { file: 'orphan/barrel.ts', reExportCount: 3, consumerCount: 0, lowValue: true },
        ],
      }
      const out = fromBarrels(data)
      expect(out).toHaveLength(2)
      expect(out.map((t) => t.target)).toEqual(['lib/index.ts', 'orphan/barrel.ts'])
    })

    it('skips barrels with no lowValue field', () => {
      const data: SnapshotShape = {
        barrels: [{ file: 'lib/index.ts', reExportCount: 5, consumerCount: 0 }],
      }
      expect(fromBarrels(data)).toEqual([])
    })
  })

  describe('fromOrphans', () => {
    it('only flags disconnected file nodes', () => {
      const data: SnapshotShape = {
        nodes: [
          { id: 'a.ts', type: 'file', status: 'connected' },
          { id: 'b.ts', type: 'file', status: 'disconnected' },
          { id: 'c.ts', type: 'file', status: 'disconnected' },
          { id: 'packages', type: 'directory', status: 'disconnected' },
        ],
      }
      const out = fromOrphans(data)
      expect(out).toHaveLength(2)
      expect(out.map((t) => t.target).sort()).toEqual(['b.ts', 'c.ts'])
    })
  })

  describe('fromLongFunctions', () => {
    it('only flags fns ≥ 80 lines', () => {
      const data: SnapshotShape = {
        longFunctions: [
          { file: 'a.ts', name: 'short', lines: 50 },
          { file: 'a.ts', name: 'medium', lines: 79 },
          { file: 'a.ts', name: 'long', lines: 80 },
          { file: 'b.ts', name: 'huge', lines: 250 },
        ],
      }
      const out = fromLongFunctions(data)
      expect(out).toHaveLength(2)
      expect(out[0].target).toBe('a.ts::long')
      expect(out[1].target).toBe('b.ts::huge')
    })

    it('uses <anon> when name is missing', () => {
      const data: SnapshotShape = {
        longFunctions: [{ file: 'a.ts', lines: 100 }],
      }
      expect(fromLongFunctions(data)[0].target).toBe('a.ts::<anon>')
    })
  })

  describe('fromDriftSignals', () => {
    it('emits one tension per drift signal', () => {
      const data: SnapshotShape = {
        driftSignals: [
          { kind: 'deep-nesting', file: 'a.ts', detail: 'depth 6' },
          { file: 'b.ts', detail: 'something' }, // no kind → defaults to 'drift'
        ],
      }
      const out = fromDriftSignals(data)
      expect(out).toHaveLength(2)
      expect(out[0].kind).toBe('deep-nesting')
      expect(out[1].kind).toBe('drift')
    })
  })
})
