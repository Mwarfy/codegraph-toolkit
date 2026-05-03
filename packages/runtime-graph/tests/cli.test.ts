/**
 * Tests pour runtime-graph/src/cli.ts — commander program structure.
 *
 * META-CRITICAL kill : on importe le program (le guard main-module
 * empêche le parseAsync) et on vérifie que les commands attendues sont
 * enregistrées. Garde-fou contre une suppression accidentelle de
 * `liby-runtime-graph capture` ou autre command load-bearing.
 */

import { describe, it, expect } from 'vitest'
import { program } from '../src/cli.js'

describe('runtime-graph CLI', () => {
  it('expose un Commander program avec name = "liby-runtime-graph"', () => {
    expect(program).toBeDefined()
    expect(program.name()).toBe('liby-runtime-graph')
  })

  it('enregistre les commands principales (run, check)', () => {
    const names = program.commands.map((c) => c.name())
    expect(names).toContain('run')
    expect(names).toContain('check')
  })

  it('chaque command a une description non-vide', () => {
    for (const cmd of program.commands) {
      const desc = cmd.description()
      expect(typeof desc).toBe('string')
      expect(desc.length).toBeGreaterThan(0)
    }
  })
})
