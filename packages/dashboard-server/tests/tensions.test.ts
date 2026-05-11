import { describe, it, expect } from 'vitest'
import {
  fromCycles,
  fromBarrels,
  fromOrphans,
  fromLongFunctions,
  fromDriftSignals,
  type TensionInputs,
} from '../src/routes/tensions.js'

describe('tension builders', () => {
  describe('fromCycles', () => {
    it('returns one tension per cycle (uses Cycle.nodes path, not fake .files)', () => {
      const data: TensionInputs = {
        nodes: [],
        cycles: [
          { nodes: ['a.ts', 'b.ts', 'a.ts'], size: 2 },
          { nodes: ['c.ts', 'd.ts', 'e.ts', 'c.ts'], size: 3 },
        ],
      }
      const out = fromCycles(data)
      expect(out).toHaveLength(2)
      expect(out[0].kind).toBe('cycle')
      // target = path join (premier == dernier, c'est attendu pour un cycle).
      expect(out[0].target).toBe('a.ts → b.ts → a.ts')
      // detail utilise Cycle.size (= nombre de fichiers uniques), pas length du path.
      expect(out[1].detail).toBe('cycle de 3 fichiers')
    })

    it('returns empty array when no cycles', () => {
      expect(fromCycles({ nodes: [] })).toEqual([])
    })
  })

  describe('fromBarrels', () => {
    it('only emits low-value barrels', () => {
      const data: TensionInputs = {
        nodes: [],
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

    it('returns empty array when no barrels', () => {
      expect(fromBarrels({ nodes: [] })).toEqual([])
    })
  })

  describe('fromOrphans', () => {
    it('matches the real "orphan" status (not the never-existing "disconnected")', () => {
      // Pre-fix : le code matchait `status === 'disconnected'` qui n'a
      // jamais été émis par le snapshot. La route renvoyait toujours 0
      // tensions orphan. Ce test verrouille le bug fix : on matche
      // maintenant la vraie valeur `'orphan'`.
      const data: TensionInputs = {
        nodes: [
          { id: 'a.ts', type: 'file', status: 'connected' },
          { id: 'b.ts', type: 'file', status: 'orphan' },
          { id: 'c.ts', type: 'file', status: 'orphan' },
          { id: 'd.ts', type: 'file', status: 'entry-point' },
          { id: 'packages', type: 'directory', status: 'orphan' },
          { id: 'e.ts', type: 'file', status: 'uncertain' },
        ],
      }
      const out = fromOrphans(data)
      // 2 fichiers orphan (directory et entry-point ignorés, uncertain pas considéré).
      expect(out).toHaveLength(2)
      expect(out.map((t) => t.target).sort()).toEqual(['b.ts', 'c.ts'])
    })

    it('legacy "disconnected" status no longer matches (was a bug)', () => {
      const data: TensionInputs = {
        nodes: [
          { id: 'a.ts', type: 'file', status: 'disconnected' },
        ],
      }
      expect(fromOrphans(data)).toEqual([])
    })

    it('ignores directory nodes even when orphan', () => {
      const data: TensionInputs = {
        nodes: [
          { id: 'packages', type: 'directory', status: 'orphan' },
        ],
      }
      expect(fromOrphans(data)).toEqual([])
    })
  })

  describe('fromLongFunctions', () => {
    it('uses real "loc" field (not the never-existing "lines"), threshold 80', () => {
      const data: TensionInputs = {
        nodes: [],
        longFunctions: [
          { file: 'a.ts', name: 'short', loc: 50 },
          { file: 'a.ts', name: 'medium', loc: 79 },
          { file: 'a.ts', name: 'long', loc: 80 },
          { file: 'b.ts', name: 'huge', loc: 250 },
        ],
      }
      const out = fromLongFunctions(data)
      expect(out).toHaveLength(2)
      expect(out[0].target).toBe('a.ts::long')
      expect(out[0].detail).toBe('80 lignes')
      expect(out[1].target).toBe('b.ts::huge')
    })

    // Note : le test "uses <anon> when name is missing" est supprimé.
    // Le vrai type `longFunctions[i].name` est non-optional — l'extractor
    // garantit un nom (ou 'anonymous' en interne pour les arrow expressions).
    // Cf. core/types.ts:DetectorOutputs.longFunctions.
  })

  describe('fromDriftSignals', () => {
    it('uses real "message" field (not the never-existing "detail")', () => {
      const data: TensionInputs = {
        nodes: [],
        driftSignals: [
          { kind: 'deep-nesting', file: 'a.ts', message: 'depth 6' },
          { kind: 'wrapper-superfluous', file: 'b.ts', message: 'one-liner wrapper' },
        ],
      }
      const out = fromDriftSignals(data)
      expect(out).toHaveLength(2)
      expect(out[0].kind).toBe('deep-nesting')
      expect(out[0].target).toBe('a.ts')
      expect(out[0].detail).toBe('depth 6')
      expect(out[1].kind).toBe('wrapper-superfluous')
    })

    // Note : le test "no kind → defaults to 'drift'" est supprimé.
    // `driftSignals[i].kind` est non-optional dans le vrai type (union
    // littérale strict). Plus de fallback nécessaire.
  })
})
