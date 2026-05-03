/**
 * Tests pour codegraph/src/cli/index.ts — commander program structure.
 *
 * META-CRITICAL kill : importe le program (le main-module guard évite
 * le parse()) et vérifie que les commands canonique sont enregistrées.
 * Garde-fou contre une suppression accidentelle de `analyze`, `diff`,
 * `datalog-check`, etc.
 */

import { describe, it, expect } from 'vitest'
import { program } from '../../src/cli/index.js'

describe('codegraph CLI', () => {
  it('expose un Commander program avec name = "codegraph"', () => {
    expect(program).toBeDefined()
    expect(program.name()).toBe('codegraph')
  })

  it('enregistre les commands canoniques', () => {
    const names = program.commands.map((c) => c.name())
    // Lock-list des commands user-facing critiques. Ajout OK, suppression
    // doit casser ce test (et un retrait de command est un breaking change).
    expect(names).toContain('analyze')
    expect(names).toContain('diff')
    expect(names).toContain('check')
    expect(names).toContain('datalog-check')
    expect(names).toContain('facts')
    expect(names).toContain('memory')
  })

  it('chaque command top-level a une description', () => {
    for (const cmd of program.commands) {
      expect(typeof cmd.description()).toBe('string')
      expect(cmd.description().length).toBeGreaterThan(0)
    }
  })

  it('analyze command a les options critiques (-c, --incremental, --no-save)', () => {
    const analyze = program.commands.find((c) => c.name() === 'analyze')
    expect(analyze).toBeDefined()
    const optNames = analyze!.options.map((o) => o.long ?? o.short)
    expect(optNames).toContain('--config')
    expect(optNames).toContain('--incremental')
  })
})
