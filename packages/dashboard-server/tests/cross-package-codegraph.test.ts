// ADR-032
/**
 * Cross-package contract test : `dashboard-server` ↔ `@liby-tools/codegraph`.
 *
 * Imports actuellement utilisés (cf. grep) :
 *   - @liby-tools/codegraph/snapshot-loader : loadStoredSnapshot,
 *     loadSnapshotFromFile, unwrapSnapshot, isSafeSnapshotFilename
 */

import { describe, it, expect } from 'vitest'

describe('cross-package contract : dashboard-server ← @liby-tools/codegraph', () => {
  it('imports snapshot-loader exports utilisés en prod', async () => {
    const mod = await import('@liby-tools/codegraph/snapshot-loader')
    expect(typeof mod.loadStoredSnapshot).toBe('function')
    expect(typeof mod.loadSnapshotFromFile).toBe('function')
    expect(typeof mod.unwrapSnapshot).toBe('function')
    expect(typeof mod.isSafeSnapshotFilename).toBe('function')
  })

  it('loadSnapshotFromFile smoke : retourne null pour path inexistant', async () => {
    const { loadSnapshotFromFile } = await import('@liby-tools/codegraph/snapshot-loader')
    const result = await loadSnapshotFromFile('/tmp/__codegraph-cross-package-not-exists__.json')
    expect(result).toBeNull()
  })

  it('loadStoredSnapshot smoke : retourne null pour dir inexistant', async () => {
    const { loadStoredSnapshot } = await import('@liby-tools/codegraph/snapshot-loader')
    const result = await loadStoredSnapshot('/tmp/__codegraph-cross-package-not-exists__')
    expect(result).toBeNull()
  })

  it('isSafeSnapshotFilename validates filenames correctly', async () => {
    const { isSafeSnapshotFilename } = await import('@liby-tools/codegraph/snapshot-loader')
    expect(isSafeSnapshotFilename('snapshot.json')).toBe(true)
    expect(isSafeSnapshotFilename('../../../etc/passwd')).toBe(false)
  })
})
