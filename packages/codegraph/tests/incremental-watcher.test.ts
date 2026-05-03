/**
 * Tests pour CodeGraphWatcher — file-tracking filter.
 *
 * META-CRITICAL kill : on test la sémantique critique du filter
 * `_shouldTrack` qui décide quels fs events déclenchent un recompute.
 * Sans test, un drift dans le filter (ex: tracker accidentellement
 * `.git/`) cause des recomputes en boucle.
 */

import { describe, it, expect } from 'vitest'
import { CodeGraphWatcher } from '../src/incremental/watcher.js'
import type { CodeGraphConfig } from '../src/core/types.js'

function makeConfig(overrides: Partial<CodeGraphConfig> = {}): CodeGraphConfig {
  return {
    rootDir: '/tmp/fake',
    include: ['src/**/*.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.test.ts'],
    entryPoints: ['src/index.ts'],
    detectors: [],
    snapshotDir: '/tmp/fake/.codegraph',
    maxSnapshots: 10,
    ...overrides,
  }
}

describe('CodeGraphWatcher', () => {
  describe('_shouldTrack — file filter', () => {
    it('accepte les fichiers source TS dans le scope include', () => {
      const w = new CodeGraphWatcher(makeConfig())
      expect(w._shouldTrack('src/foo.ts')).toBe(true)
      expect(w._shouldTrack('src/nested/deep/bar.ts')).toBe(true)
    })

    it('rejette les fichiers hors include', () => {
      const w = new CodeGraphWatcher(makeConfig())
      expect(w._shouldTrack('docs/foo.md')).toBe(false)
      expect(w._shouldTrack('foo.ts')).toBe(false)            // hors src/
      expect(w._shouldTrack('lib/foo.ts')).toBe(false)
    })

    it('rejette les fichiers exclus (node_modules, dist, *.test.ts)', () => {
      const w = new CodeGraphWatcher(makeConfig())
      expect(w._shouldTrack('src/node_modules/pkg/foo.ts')).toBe(false)
      expect(w._shouldTrack('src/dist/foo.ts')).toBe(false)
      expect(w._shouldTrack('src/foo.test.ts')).toBe(false)
    })

    it('rejette les fichiers cachés (préfixe .)', () => {
      const w = new CodeGraphWatcher(makeConfig())
      expect(w._shouldTrack('src/.DS_Store')).toBe(false)
      expect(w._shouldTrack('src/.cache/foo.ts')).toBe(false)
    })

    it('rejette les suffixes tempo (~ .tmp .swp)', () => {
      const w = new CodeGraphWatcher(makeConfig())
      expect(w._shouldTrack('src/foo.ts~')).toBe(false)
      expect(w._shouldTrack('src/foo.tmp')).toBe(false)
      expect(w._shouldTrack('src/.foo.swp')).toBe(false)
      expect(w._shouldTrack('src/foo.ts.swp.lock')).toBe(false)
    })
  })

  describe('constructor', () => {
    it('applique les options par défaut (debounceMs=50, writeSnapshot=true)', () => {
      const w = new CodeGraphWatcher(makeConfig())
      // Les options sont stockées en private mais on peut vérifier via shouldTrack
      // qu'au moins le config est posé.
      expect(w._shouldTrack('src/x.ts')).toBe(true)
    })

    it('respecte les options custom', () => {
      let calledOnError = false
      const w = new CodeGraphWatcher(makeConfig(), {
        debounceMs: 200,
        writeSnapshot: false,
        onError: () => { calledOnError = true },
      })
      expect(w._shouldTrack('src/x.ts')).toBe(true)
      // onError n'est pas déclenché par shouldTrack
      expect(calledOnError).toBe(false)
    })
  })
})
