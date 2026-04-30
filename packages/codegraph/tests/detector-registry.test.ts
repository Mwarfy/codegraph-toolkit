/**
 * Tests pour DetectorRegistry — pattern visiteur qui découpe analyze()
 * (Phase A du refactor analyzer.ts).
 *
 * Vérifie le contract : ordre déterministe, skip factsOnly, error
 * caught + timing tracké même en cas d'erreur, results stockés par
 * name. La parité bit-pour-bit avec analyze() est testée séparément
 * (parity.test.ts + golden snapshots Sentinel).
 */

import { describe, it, expect } from 'vitest'
import {
  DetectorRegistry,
  type Detector,
  type DetectorRunContext,
} from '../src/core/detector-registry.js'

function mockCtx(overrides: Partial<DetectorRunContext> = {}): DetectorRunContext {
  return {
    config: { rootDir: '/tmp/x', detectors: [] } as any,
    files: [],
    sharedProject: {} as any,
    options: {},
    results: {},
    ...overrides,
  }
}

describe('DetectorRegistry', () => {
  it('exécute les détecteurs dans l\'ordre d\'enregistrement', async () => {
    const order: string[] = []
    const det = (name: string): Detector => ({
      name,
      factsOnlyEligible: true,
      async run() { order.push(name); return name },
    })

    const reg = new DetectorRegistry()
      .register(det('alpha'))
      .register(det('beta'))
      .register(det('gamma'))

    const ctx = mockCtx()
    const timing: Record<string, number> = {}
    await reg.runAll(ctx, timing)

    expect(order).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('stocke results par name (skip undefined)', async () => {
    const reg = new DetectorRegistry()
      .register({
        name: 'returns-value',
        factsOnlyEligible: true,
        async run() { return { x: 1 } },
      })
      .register({
        name: 'returns-undefined',
        factsOnlyEligible: true,
        async run() { return undefined },
      })

    const ctx = mockCtx()
    await reg.runAll(ctx, {})

    expect(ctx.results['returns-value']).toEqual({ x: 1 })
    expect(ctx.results).not.toHaveProperty('returns-undefined')
  })

  it('skip les détecteurs non-factsOnly-eligible quand options.factsOnly', async () => {
    const ran: string[] = []
    const reg = new DetectorRegistry()
      .register({
        name: 'eligible',
        factsOnlyEligible: true,
        async run() { ran.push('eligible'); return 'a' },
      })
      .register({
        name: 'ineligible',
        factsOnlyEligible: false,
        async run() { ran.push('ineligible'); return 'b' },
      })

    const ctx = mockCtx({ options: { factsOnly: true } })
    const timing: Record<string, number> = {}
    await reg.runAll(ctx, timing)

    expect(ran).toEqual(['eligible'])
    expect(ctx.results['eligible']).toBe('a')
    expect(ctx.results).not.toHaveProperty('ineligible')
    // Pas de timing pour le détecteur skippé (différent d'un détecteur en erreur)
    expect(timing).not.toHaveProperty('ineligible')
  })

  it('exécute tous les détecteurs quand options.factsOnly est absent', async () => {
    const ran: string[] = []
    const reg = new DetectorRegistry()
      .register({
        name: 'eligible',
        factsOnlyEligible: true,
        async run() { ran.push('eligible'); return null },
      })
      .register({
        name: 'ineligible',
        factsOnlyEligible: false,
        async run() { ran.push('ineligible'); return null },
      })

    const ctx = mockCtx()
    await reg.runAll(ctx, {})

    expect(ran).toEqual(['eligible', 'ineligible'])
  })

  it('catch les erreurs sans bloquer le pipeline + log via console.error', async () => {
    const reg = new DetectorRegistry()
      .register({
        name: 'fails',
        factsOnlyEligible: true,
        async run() { throw new Error('boom') },
      })
      .register({
        name: 'succeeds',
        factsOnlyEligible: true,
        async run() { return 'ok' },
      })

    const errors: string[] = []
    const origError = console.error
    console.error = (msg: string) => errors.push(msg)
    try {
      const ctx = mockCtx()
      const timing: Record<string, number> = {}
      await reg.runAll(ctx, timing)
      // Les deux ont un timing tracké (même celui qui a péte)
      expect(timing).toHaveProperty('fails')
      expect(timing).toHaveProperty('succeeds')
      // Le succès est stocké, l'échec non
      expect(ctx.results['succeeds']).toBe('ok')
      expect(ctx.results).not.toHaveProperty('fails')
      // Error logué
      expect(errors.some(e => e.includes('fails') && e.includes('boom'))).toBe(true)
    } finally {
      console.error = origError
    }
  })

  it('track timing pour chaque détecteur exécuté', async () => {
    const reg = new DetectorRegistry()
      .register({
        name: 'instant',
        factsOnlyEligible: true,
        async run() { return 'a' },
      })
      .register({
        name: 'short-sleep',
        factsOnlyEligible: true,
        async run() {
          await new Promise(r => setTimeout(r, 10))
          return 'b'
        },
      })

    const ctx = mockCtx()
    const timing: Record<string, number> = {}
    await reg.runAll(ctx, timing)

    expect(timing['instant']).toBeGreaterThanOrEqual(0)
    expect(timing['short-sleep']).toBeGreaterThanOrEqual(5)  // marge réaliste
  })

  it('register() retourne this (chainable)', () => {
    const det: Detector = { name: 'x', factsOnlyEligible: true, async run() { return null } }
    const reg = new DetectorRegistry()
    expect(reg.register(det)).toBe(reg)
  })
})
