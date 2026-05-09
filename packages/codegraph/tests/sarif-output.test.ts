/**
 * Tests SARIF 2.1.0 output formatter.
 *
 * Spec : https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
 */

import { describe, it, expect } from 'vitest'
import { buildSarifReport, type SarifViolation } from '../src/output/sarif.js'

const TOOL_OPTS = { toolVersion: '0.6.0' }

describe('buildSarifReport — schema', () => {
  it('emit version 2.1.0 + schema URI', () => {
    const r = buildSarifReport([], TOOL_OPTS)
    expect(r.version).toBe('2.1.0')
    expect(r.$schema).toBe('https://json.schemastore.org/sarif-2.1.0')
  })

  it('contient exactement 1 run', () => {
    const r = buildSarifReport([], TOOL_OPTS)
    expect(r.runs).toHaveLength(1)
  })

  it('tool.driver name + version', () => {
    const r = buildSarifReport([], TOOL_OPTS)
    expect(r.runs[0].tool.driver.name).toBe('codegraph')
    expect(r.runs[0].tool.driver.version).toBe('0.6.0')
    expect(r.runs[0].tool.driver.informationUri).toContain('github.com')
  })

  it('toolUri override est preserve', () => {
    const r = buildSarifReport([], { toolVersion: '1.0.0', toolUri: 'https://example.com/tool' })
    expect(r.runs[0].tool.driver.informationUri).toBe('https://example.com/tool')
  })
})

describe('buildSarifReport — rules deduplication', () => {
  it('dedupe les rules par id en preservant l ordre de premiere apparition', () => {
    const violations: SarifViolation[] = [
      { adr: 'RULE-A', file: 'a.ts', line: 1, msg: 'msg A1' },
      { adr: 'RULE-B', file: 'b.ts', line: 1, msg: 'msg B1' },
      { adr: 'RULE-A', file: 'c.ts', line: 5, msg: 'msg A2' },  // duplicate id
    ]
    const r = buildSarifReport(violations, TOOL_OPTS)
    const rules = r.runs[0].tool.driver.rules
    expect(rules).toHaveLength(2)
    expect(rules[0].id).toBe('RULE-A')
    expect(rules[1].id).toBe('RULE-B')
  })

  it('rule.fullDescription = premier message rencontre', () => {
    const r = buildSarifReport([
      { adr: 'RULE-X', file: 'a.ts', line: 1, msg: 'first message' },
      { adr: 'RULE-X', file: 'b.ts', line: 2, msg: 'second message' },
    ], TOOL_OPTS)
    expect(r.runs[0].tool.driver.rules[0].fullDescription.text).toBe('first message')
  })

  it('helpUri inclut l id en lowercase', () => {
    const r = buildSarifReport([
      { adr: 'COMPOSITE-CYCLE', file: 'a.ts', line: 1, msg: 'cycle' },
    ], TOOL_OPTS)
    expect(r.runs[0].tool.driver.rules[0].helpUri).toContain('rule-composite-cycle')
  })

  it('defaultConfiguration level = warning', () => {
    const r = buildSarifReport([
      { adr: 'X', file: 'a.ts', line: 1, msg: 'x' },
    ], TOOL_OPTS)
    expect(r.runs[0].tool.driver.rules[0].defaultConfiguration.level).toBe('warning')
  })
})

describe('buildSarifReport — results', () => {
  it('emit 1 result par violation (pas dedupe)', () => {
    const violations: SarifViolation[] = [
      { adr: 'RULE-A', file: 'a.ts', line: 1, msg: 'msg' },
      { adr: 'RULE-A', file: 'a.ts', line: 1, msg: 'msg' },  // exact duplicate, garde quand meme
      { adr: 'RULE-B', file: 'b.ts', line: 5, msg: 'msg' },
    ]
    const r = buildSarifReport(violations, TOOL_OPTS)
    expect(r.runs[0].results).toHaveLength(3)
  })

  it('result.ruleId match l adr de violation', () => {
    const r = buildSarifReport([
      { adr: 'COMPOSITE-CYCLE', file: 'src/foo.ts', line: 10, msg: 'cycle detected' },
    ], TOOL_OPTS)
    expect(r.runs[0].results[0].ruleId).toBe('COMPOSITE-CYCLE')
  })

  it('result.message.text = msg de violation', () => {
    const r = buildSarifReport([
      { adr: 'X', file: 'foo.ts', line: 1, msg: 'cycle non-gated detected' },
    ], TOOL_OPTS)
    expect(r.runs[0].results[0].message.text).toBe('cycle non-gated detected')
  })

  it('result.level = warning par defaut', () => {
    const r = buildSarifReport([
      { adr: 'X', file: 'foo.ts', line: 1, msg: 'x' },
    ], TOOL_OPTS)
    expect(r.runs[0].results[0].level).toBe('warning')
  })
})

describe('buildSarifReport — locations', () => {
  it('physicalLocation contient artifactLocation + region quand line > 0', () => {
    const r = buildSarifReport([
      { adr: 'X', file: 'src/foo.ts', line: 42, msg: 'x' },
    ], TOOL_OPTS)
    const loc = r.runs[0].results[0].locations[0]
    expect(loc.physicalLocation.artifactLocation.uri).toBe('src/foo.ts')
    expect(loc.physicalLocation.artifactLocation.uriBaseId).toBe('%SRCROOT%')
    expect(loc.physicalLocation.region?.startLine).toBe(42)
  })

  it('region absent quand line = 0 (violation niveau package.json)', () => {
    const r = buildSarifReport([
      { adr: 'COMPOSITE-DEP-UNUSED', file: 'package.json', line: 0, msg: 'unused' },
    ], TOOL_OPTS)
    const loc = r.runs[0].results[0].locations[0]
    expect(loc.physicalLocation.artifactLocation.uri).toBe('package.json')
    expect(loc.physicalLocation.region).toBeUndefined()
  })

  it('locations vide quand file empty (violation sans cible)', () => {
    const r = buildSarifReport([
      { adr: 'X', file: '', line: 0, msg: 'global violation' },
    ], TOOL_OPTS)
    expect(r.runs[0].results[0].locations).toHaveLength(0)
  })
})

describe('buildSarifReport — determinisme', () => {
  it('meme input → meme output (byte-equivalent)', () => {
    const violations: SarifViolation[] = [
      { adr: 'A', file: 'x.ts', line: 1, msg: 'm1' },
      { adr: 'B', file: 'y.ts', line: 2, msg: 'm2' },
    ]
    const r1 = JSON.stringify(buildSarifReport(violations, TOOL_OPTS))
    const r2 = JSON.stringify(buildSarifReport(violations, TOOL_OPTS))
    expect(r1).toBe(r2)
  })
})

describe('buildSarifReport — empty input', () => {
  it('retourne un report valide sans rules ni results', () => {
    const r = buildSarifReport([], TOOL_OPTS)
    expect(r.runs[0].tool.driver.rules).toHaveLength(0)
    expect(r.runs[0].results).toHaveLength(0)
  })
})
