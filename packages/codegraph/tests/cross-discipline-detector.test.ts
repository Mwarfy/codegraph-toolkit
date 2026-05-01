/**
 * Contract test pour CrossDisciplineDetector (POC Phase d'après).
 *
 * Vérifie que la class implements Detector correctement et est
 * instanciable. Migration complète vers le DetectorRegistry demande
 * un refactor du flow analyzer (cross-discipline tourne post-snapshot
 * mutables, pas pendant le registry pass).
 *
 * Backlog : restructurer analyzer.ts pour permettre des detectors
 * "post-snapshot" registrés dans un secondary registry.
 */

import { describe, it, expect } from 'vitest'
import { CrossDisciplineDetector } from '../src/core/detectors/cross-discipline-detector.js'

describe('CrossDisciplineDetector — contract', () => {
  it('instanciable + implements Detector interface', () => {
    const d = new CrossDisciplineDetector()
    expect(d.name).toBe('cross-discipline')
    expect(d.factsOnlyEligible).toBe(false)
    expect(typeof d.run).toBe('function')
  })

  it('run() retourne undefined si snapshot manquant (graceful skip)', async () => {
    const d = new CrossDisciplineDetector()
    // Mock un ctx minimal sans snapshot — devrait skip
    const ctx = {
      config: { rootDir: '/tmp' },
      files: [],
      // sharedProject + graph + autres : non utilisés si snapshot absent
    } as unknown as Parameters<typeof d.run>[0]
    const result = await d.run(ctx)
    expect(result).toBeUndefined()
  })

  it('expose le name pour timing tracking', () => {
    const d = new CrossDisciplineDetector()
    expect(d.name).toMatch(/^[a-z][a-z-]*$/) // kebab-case lowercase
  })
})
