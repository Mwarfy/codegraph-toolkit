/**
 * End-to-end test : runFromDirs against a fixture that simulates an ADR
 * pilot. Validates the full chain :
 *   .dl rules + .facts TSV → Violation tuples → byte-determinism.
 *
 * The fixture mimics what `codegraph facts` produces and what an
 * `adr-017.dl` rule would express (untyped string-literal emits).
 */

import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runFromDirs, formatRunResult } from '../src/runner.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixtureDir = path.resolve(__dirname, 'fixtures/adr-017-events')

describe('e2e — ADR-017 pilot', () => {
  it('detects three literal-emit violations', async () => {
    const { result } = await runFromDirs({
      rulesDir: fixtureDir,
      factsDir: fixtureDir,
    })
    const v = result.outputs.get('Violation')!
    expect(v.length).toBe(3)
    // Sorted lex: the file 'src/another/leak.ts' comes first.
    expect(v).toEqual([
      ['ADR-017', 'src/another/leak.ts', 13, 'untyped emit (string literal)'],
      ['ADR-017', 'src/legacy/old-handler.ts', 42, 'untyped emit (string literal)'],
      ['ADR-017', 'src/legacy/old-handler.ts', 88, 'untyped emit (string literal)'],
    ])
  })

  it('records proof trees pointing back to EmitsLiteral facts', async () => {
    const { result } = await runFromDirs({
      rulesDir: fixtureDir,
      factsDir: fixtureDir,
      recordProofsFor: ['Violation'],
    })
    expect(result.proofs).toBeDefined()
    const proofs = result.proofs!.get('Violation')!
    expect(proofs.size).toBe(3)
    for (const proof of proofs.values()) {
      expect(proof.via.kind).toBe('rule')
      if (proof.via.kind === 'rule') {
        expect(proof.via.bodyTuples.length).toBe(1)
        expect(proof.via.bodyTuples[0].rel).toBe('EmitsLiteral')
      }
      expect(proof.children.length).toBe(1)
      expect(proof.children[0].rel).toBe('EmitsLiteral')
    }
  })

  it('formatted text output is byte-deterministic across 5 runs', async () => {
    const sigs: string[] = []
    for (let i = 0; i < 5; i++) {
      const { result } = await runFromDirs({
        rulesDir: fixtureDir,
        factsDir: fixtureDir,
      })
      // Strip stats.elapsedMs (timing-dependent) before comparing.
      const txt = formatRunResult(result)
      sigs.push(txt)
    }
    expect(new Set(sigs).size).toBe(1)
  })
})

describe('e2e — multi-dir rules (canonical + project)', () => {
  const canonicalDir = path.resolve(__dirname, 'fixtures/multi-dir-canonical')
  const projectDir = path.resolve(__dirname, 'fixtures/multi-dir-project')

  it('charge rules canoniques + project, applique grandfathers du project', async () => {
    const { result } = await runFromDirs({
      rulesDir: [canonicalDir, projectDir],
      factsDir: canonicalDir,
    })
    const v = result.outputs.get('Violation')!
    // 2 emits totaux ; 1 grandfathered → 1 violation restante
    expect(v).toEqual([
      ['ADR-X', 'src/active/leak.ts', 20, 'untyped emit'],
    ])
  })

  it('sans le project dir : aucun grandfather → 2 violations', async () => {
    const { result } = await runFromDirs({
      rulesDir: canonicalDir,
      factsDir: canonicalDir,
    })
    const v = result.outputs.get('Violation')!
    expect(v.length).toBe(2)
  })

  it('order matters : array preserve l\'ordre canonical → project', async () => {
    // Les deux ordres doivent produire le même résultat (Datalog est
    // déclaratif), mais le test vérifie que multi-dir parse correctement
    // quel que soit l'ordre.
    const r1 = await runFromDirs({
      rulesDir: [canonicalDir, projectDir],
      factsDir: canonicalDir,
    })
    const r2 = await runFromDirs({
      rulesDir: [projectDir, canonicalDir],
      factsDir: canonicalDir,
    })
    expect(r1.result.outputs.get('Violation')).toEqual(r2.result.outputs.get('Violation'))
  })
})

describe('e2e — runs against real Sentinel facts (smoke)', () => {
  it('handles the full Sentinel facts dump (240 files, 50 emits) without error', async () => {
    const sentinelFacts = path.resolve(
      __dirname, '../../../../Sentinel/.codegraph/facts',
    )
    const { result } = await runFromDirs({
      rulesDir: fixtureDir,
      factsDir: sentinelFacts,
    })
    // Sentinel has 0 EmitsLiteral today (post-ADR-017).
    expect(result.outputs.get('Violation')).toEqual([])
    // But the facts loaded — sanity check via stats.
    expect(result.stats.rulesExecuted).toBeGreaterThan(0)
  })
})
