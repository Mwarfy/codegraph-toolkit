/**
 * Tests de `cli/commands/taint.ts` — fonctions pures extraites de
 * `runTaintCommand` (refactor complexité cyclo 16 / cognitive 28 →
 * orchestrateur + helpers). Couvre le seuil de sévérité et le comptage.
 */

import { describe, it, expect } from 'vitest'
import { filterBySeverity, countBySeverity } from '../src/cli/commands/taint.js'
import type { TaintViolation } from '../src/core/types.js'

function v(severity: TaintViolation['severity']): TaintViolation {
  return { sourceName: 's', sinkName: 'k', severity, file: 'f.ts', line: 1, symbol: '', chain: [] }
}

describe('filterBySeverity', () => {
  it('garde les violations >= seuil (high → high + critical)', () => {
    const violations = [v('low'), v('medium'), v('high'), v('critical')]
    const kept = filterBySeverity(violations, 'high').map((x) => x.severity)
    expect(kept).toEqual(['high', 'critical'])
  })

  it('garde tout au seuil le plus bas', () => {
    const violations = [v('low'), v('critical')]
    expect(filterBySeverity(violations, 'low')).toHaveLength(2)
  })

  it('préserve l ordre d origine des violations conservées', () => {
    const violations = [v('critical'), v('medium'), v('high')]
    expect(filterBySeverity(violations, 'high').map((x) => x.severity)).toEqual(['critical', 'high'])
  })
})

describe('countBySeverity', () => {
  it('compte par sévérité avec zéro pour les absentes', () => {
    const violations = [v('critical'), v('high'), v('high'), v('low')]
    expect(countBySeverity(violations)).toEqual({ critical: 1, high: 2, medium: 0, low: 1 })
  })
})
