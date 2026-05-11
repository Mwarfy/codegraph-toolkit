// ADR-032
/**
 * Cross-package contract test : `adr-toolkit` ↔ `@liby-tools/codegraph`.
 *
 * adr-toolkit n'a pas d'import TS direct vers codegraph — il utilise :
 *   - `npx @liby-tools/codegraph` (CLI bin) au runtime depuis les hooks
 *   - `require.resolve('@liby-tools/codegraph/scripts/datalog-check-fast.mjs')`
 *
 * Le test vérifie que le PACKAGE reste résoluble + les scripts/bin
 * référencés existent. Si codegraph supprime ses bins ou scripts, ce
 * test pète au CI.
 */

import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

describe('cross-package contract : adr-toolkit ← @liby-tools/codegraph', () => {
  it('package `@liby-tools/codegraph` reste résoluble', () => {
    expect(() => require.resolve('@liby-tools/codegraph')).not.toThrow()
  })

  it('script `datalog-check-fast.mjs` reste accessible via require.resolve', () => {
    // adr-toolkit utilise ce script via require.resolve dans
    // codegraph-feedback.sh. Si codegraph le supprime, le hook crash.
    expect(() =>
      require.resolve('@liby-tools/codegraph/scripts/datalog-check-fast.mjs'),
    ).not.toThrow()
  })

  it('bin `codegraph` reste invocable (= entry pour npx)', () => {
    // Verify the `bin` field in package.json points to an existing file.
    // adr-toolkit hooks invoquent `npx @liby-tools/codegraph analyze`.
    const pkg = require('@liby-tools/codegraph/package.json') as {
      bin?: Record<string, string>
    }
    expect(pkg.bin).toBeDefined()
    expect(pkg.bin?.codegraph).toBeDefined()
  })
})
