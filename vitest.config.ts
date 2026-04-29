import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.test.ts'],
    // Legacy tests in Sentinel utilisaient node:assert + run().catch() pattern.
    // On ne les inclut pas ici. Pour les exécuter : tsx packages/codegraph/tests/<name>.test.ts
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // Fixtures contenant des fichiers `*.test.ts` qui sont des INPUTS pour
      // les tests legacy, pas des tests vitest eux-mêmes.
      '**/tests/fixtures/**',
      // Legacy Sentinel-style tests (scripts plats, pas vitest)
      'packages/codegraph/tests/cycles.test.ts',
      'packages/codegraph/tests/data-flows.test.ts',
      'packages/codegraph/tests/state-machines.test.ts',
      'packages/codegraph/tests/typed-calls.test.ts',
      'packages/codegraph/tests/truth-points.test.ts',
      'packages/codegraph/tests/env-usage.test.ts',
      'packages/codegraph/tests/event-emit-sites.test.ts',
      'packages/codegraph/tests/facts.test.ts',
      'packages/codegraph/tests/package-deps.test.ts',
      'packages/codegraph/tests/taint.test.ts',
      'packages/codegraph/tests/component-metrics.test.ts',
      'packages/codegraph/tests/module-metrics.test.ts',
      'packages/codegraph/tests/check.test.ts',
      'packages/codegraph/tests/diff-structural.test.ts',
      'packages/codegraph/tests/dsm.test.ts',
      'packages/codegraph/tests/map.test.ts',
      'packages/codegraph/tests/reachability.test.ts',
    ],
  },
})
