/**
 * Test d'invariant : la fusion monoïdale parallèle produit le même résultat
 * que la version séquentielle, bit-pour-bit, indépendamment de l'ordre
 * d'évaluation des workers.
 *
 * Ce test prouve empiriquement le théorème de Church-Rosser confluence
 * sur notre implémentation : pour tout monoïde commutatif, parallelMap
 * est équivalent à un fold séquentiel.
 *
 * Pour les monoïdes non-commutatifs (appendSortedMonoid), on vérifie que
 * sortFn restaure l'ordre canonique → bit-identique à n_runs runs.
 */

import { describe, it, expect } from 'vitest'
import {
  sumNumberMonoid,
  maxNumberMonoid,
  setUnionMonoid,
  mapMonoid,
  appendSortedMonoid,
  foldMonoid,
} from '../src/parallel/monoid.js'
import { parallelMap } from '../src/parallel/bsp-scheduler.js'

describe('parallel — monoid algebra', () => {
  it('sumNumberMonoid : commutatif, parallèle ≡ séquentiel', async () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const seq = items.reduce((a, b) => a + b, 0)
    const r = await parallelMap({
      items,
      workerFn: async (n) => n,
      monoid: sumNumberMonoid,
      concurrency: 4,
    })
    expect(r.result).toBe(seq)
    expect(r.result).toBe(55)
  })

  it('maxNumberMonoid : capture le max indépendamment de l\'ordre', async () => {
    const items = [3, 1, 7, 2, 9, 5, 4, 8, 6]
    const r = await parallelMap({
      items,
      workerFn: async (n) => n,
      monoid: maxNumberMonoid,
    })
    expect(r.result).toBe(9)
  })

  it('setUnionMonoid : union ne dépend pas de l\'ordre', async () => {
    const r = await parallelMap({
      items: [['a', 'b'], ['b', 'c'], ['d']],
      workerFn: async (arr) => new Set(arr),
      monoid: setUnionMonoid<string>(),
    })
    expect([...r.result].sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('mapMonoid + sumNumberMonoid : count merging par clé', async () => {
    const r = await parallelMap({
      items: [['a', 'b', 'a'], ['b', 'c'], ['a']],
      workerFn: async (arr) => {
        const m = new Map<string, number>()
        for (const k of arr) m.set(k, (m.get(k) ?? 0) + 1)
        return m
      },
      monoid: mapMonoid<string, number>(sumNumberMonoid),
    })
    expect(r.result.get('a')).toBe(3)
    expect(r.result.get('b')).toBe(2)
    expect(r.result.get('c')).toBe(1)
  })

  it('appendSortedMonoid : output déterministe sur 100 runs', async () => {
    interface Fact { file: string; line: number; msg: string }
    const items: Fact[][] = [
      [{ file: 'b.ts', line: 5, msg: 'X' }, { file: 'a.ts', line: 3, msg: 'Y' }],
      [{ file: 'c.ts', line: 1, msg: 'Z' }],
      [{ file: 'a.ts', line: 7, msg: 'W' }],
    ]
    const monoid = appendSortedMonoid<Fact>((f) => `${f.file}:${f.line}`)
    const seq = foldMonoid(items, monoid)

    // 100 runs en parallèle → tous bit-identiques au seq
    const runs: string[] = []
    for (let i = 0; i < 100; i++) {
      const r = await parallelMap({
        items,
        workerFn: async (arr) => arr,
        monoid,
        concurrency: 3,
      })
      runs.push(JSON.stringify(r.result))
    }
    const seqJson = JSON.stringify(seq)
    for (const run of runs) {
      expect(run).toBe(seqJson)
    }
    // Vérif l'ordre lex sur (file, line)
    const result = JSON.parse(runs[0]) as Fact[]
    expect(result.map((f) => `${f.file}:${f.line}`)).toEqual([
      'a.ts:3',
      'a.ts:7',
      'b.ts:5',
      'c.ts:1',
    ])
  })

  it('parallelMap : items vides → result = monoid.empty', async () => {
    const r = await parallelMap({
      items: [] as number[],
      workerFn: async (n) => n,
      monoid: sumNumberMonoid,
    })
    expect(r.result).toBe(0)
    expect(r.stats.itemCount).toBe(0)
  })

  it('parallelMap stats : speedup ≥ 1 quand workerFn est lent', async () => {
    const items = Array.from({ length: 8 }, (_, i) => i)
    const r = await parallelMap({
      items,
      workerFn: async (n) => {
        await new Promise((res) => setTimeout(res, 10))
        return n
      },
      monoid: sumNumberMonoid,
      concurrency: 8,
    })
    // 8 workers × 10ms chacun = 80ms total seq, mais en parallel ~10-15ms wall
    expect(r.stats.totalWorkerMs).toBeGreaterThanOrEqual(70)
    expect(r.stats.durationMs).toBeLessThan(50)
    expect(r.stats.speedup).toBeGreaterThan(2)
  })

  it('concurrency cap : respecte la limite (smoke)', async () => {
    let active = 0
    let maxActive = 0
    const items = Array.from({ length: 20 }, (_, i) => i)
    await parallelMap({
      items,
      workerFn: async (n) => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((res) => setTimeout(res, 5))
        active--
        return n
      },
      monoid: sumNumberMonoid,
      concurrency: 4,
    })
    expect(maxActive).toBeLessThanOrEqual(4)
  })
})
