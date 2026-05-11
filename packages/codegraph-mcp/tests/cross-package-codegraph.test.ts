// ADR-032
/**
 * Cross-package contract test : `codegraph-mcp` ↔ `@liby-tools/codegraph`.
 *
 * Vérifie que les exports utilisés en prod par codegraph-mcp restent
 * disponibles. Si codegraph (upstream) supprime/renomme un export, ce
 * test pète au CI **avant le merge**, plutôt qu'en cascade après.
 *
 * Smoke test minimal : import + appel fonctionnel basique. Le but
 * n'est PAS de tester la logique métier (couverte par les tests
 * unitaires de codegraph), c'est de garantir la stabilité du contract
 * d'export.
 *
 * Imports actuellement utilisés par codegraph-mcp (cf. grep) :
 *   - @liby-tools/codegraph/snapshot-loader : unwrapSnapshot, isSafeSnapshotFilename
 *   - @liby-tools/codegraph/diff : buildStructuralDiff, renderStructuralDiffMarkdown
 */

import { describe, it, expect } from 'vitest'

describe('cross-package contract : codegraph-mcp ← @liby-tools/codegraph', () => {
  it('imports snapshot-loader exports (unwrapSnapshot, isSafeSnapshotFilename)', async () => {
    const mod = await import('@liby-tools/codegraph/snapshot-loader')
    expect(typeof mod.unwrapSnapshot).toBe('function')
    expect(typeof mod.isSafeSnapshotFilename).toBe('function')
    expect(typeof mod.loadStoredSnapshot).toBe('function')
    expect(typeof mod.loadSnapshotFromFile).toBe('function')
  })

  it('unwrapSnapshot smoke : v2 wrapper → payload', async () => {
    const { unwrapSnapshot } = await import('@liby-tools/codegraph/snapshot-loader')
    const v2 = { version: 2, meta: { version: 2, inputHash: 'h', generatedAt: 'x' }, payload: { nodes: [] } }
    expect(unwrapSnapshot(v2)).toEqual({ nodes: [] })
  })

  it('isSafeSnapshotFilename smoke : accepts canonical + rejects traversal', async () => {
    const { isSafeSnapshotFilename } = await import('@liby-tools/codegraph/snapshot-loader')
    expect(isSafeSnapshotFilename('snapshot.json')).toBe(true)
    expect(isSafeSnapshotFilename('snapshot.json.bak')).toBe(true)
    expect(isSafeSnapshotFilename('snapshot-2026-05-10T20-40-10-abc1234.json')).toBe(true)
    expect(isSafeSnapshotFilename('../../../etc/passwd')).toBe(false)
    expect(isSafeSnapshotFilename('random.json')).toBe(false)
  })

  it('imports diff exports (buildStructuralDiff, renderStructuralDiffMarkdown)', async () => {
    const mod = await import('@liby-tools/codegraph/diff')
    expect(typeof mod.buildStructuralDiff).toBe('function')
    expect(typeof mod.renderStructuralDiffMarkdown).toBe('function')
  })
})
