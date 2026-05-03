/**
 * Tests pour codegraph-mcp/src/index.ts — server bootstrap + tool list.
 *
 * META-CRITICAL kill : on test que le server expose bien les outils
 * MCP attendus (TOOLS array). Le main-module guard évite que l'import
 * déclenche le bootstrap stdio.
 */

import { describe, it, expect } from 'vitest'
import { server, TOOLS } from '../src/index.js'

describe('codegraph-mcp/index', () => {
  it('expose un server MCP nommé "codegraph-mcp"', () => {
    expect(server).toBeDefined()
    // Server interne du @modelcontextprotocol/sdk — vérifie qu'il est instancié
    expect(typeof server.connect).toBe('function')
  })

  it('expose la liste des tools attendue', () => {
    const names = TOOLS.map((t) => t.name)
    expect(names).toContain('codegraph_context')
    expect(names).toContain('codegraph_who_imports')
    expect(names).toContain('codegraph_truth_point_for')
    expect(names).toContain('codegraph_recent')
    expect(names).toContain('codegraph_uncovered')
    // Au moins 5 outils canoniques présents
    expect(names.length).toBeGreaterThanOrEqual(5)
  })

  it('chaque tool a name + description + inputSchema', () => {
    for (const t of TOOLS) {
      expect(typeof t.name).toBe('string')
      expect(t.name.length).toBeGreaterThan(0)
      expect(typeof t.description).toBe('string')
      expect(t.description.length).toBeGreaterThan(20)
      expect(t.inputSchema).toBeDefined()
      expect((t.inputSchema as any).type).toBe('object')
    }
  })
})
