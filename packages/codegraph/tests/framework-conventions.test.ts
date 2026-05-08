/**
 * Tests des extensions OSS conventions de `framework-conventions.ts`.
 *
 * Couvre les nouveaux helpers ajoutes dans :
 *   - PR #8 (P1) : isTestEntryPoint etendu, isScriptEntryPoint, isOssLayoutEntryPoint
 *   - PR #10 (workspaces) : isFrameworkEntryPoint composition
 *
 * Pas une integration test : on cible chaque predicate individuellement
 * pour blinder les regressions sur les patterns identifies dans les
 * dogfoods (Happenin, dpl-rag, Janus, OSS-AUDIT).
 */

import { describe, it, expect } from 'vitest'
import {
  isTestEntryPoint,
  isScriptEntryPoint,
  isOssLayoutEntryPoint,
  isFrameworkEntryPoint,
  isToolConfigFile,
  isNextJsRouteFile,
} from '../src/core/framework-conventions.js'

describe('isTestEntryPoint', () => {
  it('match vitest/jest *.test.{ts,tsx}', () => {
    expect(isTestEntryPoint('src/foo.test.ts')).toBe(true)
    expect(isTestEntryPoint('src/foo.test.tsx')).toBe(true)
    expect(isTestEntryPoint('packages/x/src/foo.test.ts')).toBe(true)
  })

  it('match *.spec.{ts,tsx}', () => {
    expect(isTestEntryPoint('src/foo.spec.ts')).toBe(true)
    expect(isTestEntryPoint('src/foo.spec.tsx')).toBe(true)
  })

  it('match *.stories.{ts,tsx} (Storybook)', () => {
    expect(isTestEntryPoint('src/Button.stories.tsx')).toBe(true)
    expect(isTestEntryPoint('src/components/Card.stories.ts')).toBe(true)
  })

  it('match *.test-d.ts (vitest type tests)', () => {
    expect(isTestEntryPoint('packages/svelte-query/tests/createQuery.test-d.ts')).toBe(true)
    expect(isTestEntryPoint('foo.test-d.mts')).toBe(true)
  })

  it('match *.svelte.ts (Svelte 5 reactive)', () => {
    expect(isTestEntryPoint('packages/svelte-query/src/utils.svelte.ts')).toBe(true)
  })

  it('match test-setup.ts (variant generique)', () => {
    expect(isTestEntryPoint('packages/x/test-setup.ts')).toBe(true)
    expect(isTestEntryPoint('test-setup.ts')).toBe(true)
  })

  it('match __tests__/ directory', () => {
    expect(isTestEntryPoint('src/__tests__/foo.ts')).toBe(true)
    expect(isTestEntryPoint('__tests__/utils.ts')).toBe(true)
  })

  it('match __testfixtures__/ (jscodeshift codemods)', () => {
    expect(isTestEntryPoint('packages/codemods/src/v4/__testfixtures__/default-import.input.tsx')).toBe(true)
    expect(isTestEntryPoint('__testfixtures__/output.ts')).toBe(true)
  })

  it('match __mocks__/ (vitest/jest manual mocks)', () => {
    expect(isTestEntryPoint('src/__mocks__/useQuery.ts')).toBe(true)
    expect(isTestEntryPoint('__mocks__/api.ts')).toBe(true)
  })

  it('does NOT match regular source files', () => {
    expect(isTestEntryPoint('src/foo.ts')).toBe(false)
    expect(isTestEntryPoint('src/components/Button.tsx')).toBe(false)
    expect(isTestEntryPoint('lib/utils.ts')).toBe(false)
  })

  it('does NOT match files with similar names mais hors convention', () => {
    expect(isTestEntryPoint('src/test.ts')).toBe(false)  // pas .test.ts
    expect(isTestEntryPoint('src/setupTests.ts')).toBe(false)  // pas test-setup
  })
})

describe('isScriptEntryPoint', () => {
  it('match scripts/ a la racine', () => {
    expect(isScriptEntryPoint('scripts/build.ts')).toBe(true)
    expect(isScriptEntryPoint('scripts/ci/lint.mjs')).toBe(true)
  })

  it('match scripts/ imbrique', () => {
    expect(isScriptEntryPoint('packages/x/scripts/release.ts')).toBe(true)
  })

  it('match bin/', () => {
    expect(isScriptEntryPoint('bin/cli.ts')).toBe(true)
    expect(isScriptEntryPoint('packages/x/bin/run.js')).toBe(true)
  })

  it('does NOT match les fichiers reguliers', () => {
    expect(isScriptEntryPoint('src/foo.ts')).toBe(false)
    expect(isScriptEntryPoint('script.ts')).toBe(false)  // pas dans scripts/
  })
})

describe('isOssLayoutEntryPoint', () => {
  it('match examples/', () => {
    expect(isOssLayoutEntryPoint('examples/react/basic/src/index.tsx')).toBe(true)
    expect(isOssLayoutEntryPoint('packages/x/examples/foo.ts')).toBe(true)
  })

  it('match benchmarks/', () => {
    expect(isOssLayoutEntryPoint('benchmarks/deno/fast.ts')).toBe(true)
    expect(isOssLayoutEntryPoint('benchmarks/http-server/benchmark.ts')).toBe(true)
  })

  it('match samples/, demos/, playground/', () => {
    expect(isOssLayoutEntryPoint('samples/auth/index.ts')).toBe(true)
    expect(isOssLayoutEntryPoint('demos/foo.ts')).toBe(true)
    expect(isOssLayoutEntryPoint('playground/test.ts')).toBe(true)
  })

  it('match runtime-tests/, perf-measures/ (hono patterns)', () => {
    expect(isOssLayoutEntryPoint('runtime-tests/bun/index.test.ts')).toBe(true)
    expect(isOssLayoutEntryPoint('perf-measures/jsx/dist.bench.ts')).toBe(true)
  })

  it('match www/, website/ (sites doc)', () => {
    expect(isOssLayoutEntryPoint('www/src/components/Card.tsx')).toBe(true)
    expect(isOssLayoutEntryPoint('website/pages/index.tsx')).toBe(true)
  })

  it('match suffix *.examples.ts (mcp-sdk pattern)', () => {
    expect(isOssLayoutEntryPoint('packages/client/src/auth.examples.ts')).toBe(true)
    expect(isOssLayoutEntryPoint('foo.examples.tsx')).toBe(true)
  })

  it('match suffix *.bench.ts', () => {
    expect(isOssLayoutEntryPoint('foo.bench.ts')).toBe(true)
    expect(isOssLayoutEntryPoint('packages/x/src/perf.bench.tsx')).toBe(true)
  })

  it('does NOT match regular source files', () => {
    expect(isOssLayoutEntryPoint('src/foo.ts')).toBe(false)
    expect(isOssLayoutEntryPoint('packages/x/src/lib.ts')).toBe(false)
    expect(isOssLayoutEntryPoint('app/page.tsx')).toBe(false)
  })

  it('does NOT match les fichiers contenant "example" mais hors convention', () => {
    expect(isOssLayoutEntryPoint('src/example.ts')).toBe(false)  // pas examples/, pas .examples.ts
  })
})

describe('isToolConfigFile', () => {
  it('match les configs frequents', () => {
    expect(isToolConfigFile('vitest.config.ts')).toBe(true)
    expect(isToolConfigFile('next.config.ts')).toBe(true)
    expect(isToolConfigFile('eslint.config.mjs')).toBe(true)
    expect(isToolConfigFile('tsup.config.ts')).toBe(true)
  })

  it('match les setup files de test runners', () => {
    expect(isToolConfigFile('vitest.setup.ts')).toBe(true)
    expect(isToolConfigFile('jest.setup.ts')).toBe(true)
  })

  it('match Sentry triple config', () => {
    expect(isToolConfigFile('sentry.client.config.ts')).toBe(true)
    expect(isToolConfigFile('sentry.server.config.ts')).toBe(true)
    expect(isToolConfigFile('sentry.edge.config.ts')).toBe(true)
  })

  it('match vercel.ts (Vercel TS config 2026)', () => {
    expect(isToolConfigFile('vercel.ts')).toBe(true)
  })

  it('match nested config files', () => {
    expect(isToolConfigFile('apps/web/next.config.ts')).toBe(true)
    expect(isToolConfigFile('packages/x/vitest.config.ts')).toBe(true)
  })
})

describe('isNextJsRouteFile', () => {
  it('match Next.js App Router files dans app/', () => {
    expect(isNextJsRouteFile('app/page.tsx')).toBe(true)
    expect(isNextJsRouteFile('app/layout.tsx')).toBe(true)
    expect(isNextJsRouteFile('app/api/hello/route.ts')).toBe(true)
    expect(isNextJsRouteFile('src/app/dashboard/page.tsx')).toBe(true)
  })

  it('match root-level conventions (middleware, instrumentation, proxy)', () => {
    expect(isNextJsRouteFile('middleware.ts')).toBe(true)
    expect(isNextJsRouteFile('proxy.ts')).toBe(true)  // Next.js 16
    expect(isNextJsRouteFile('instrumentation.ts')).toBe(true)
    expect(isNextJsRouteFile('instrumentation-client.ts')).toBe(true)
  })

  it('does NOT match outside app/', () => {
    expect(isNextJsRouteFile('lib/page.tsx')).toBe(false)
    expect(isNextJsRouteFile('components/page.tsx')).toBe(false)
  })

  it('does NOT match regular source files dans app/', () => {
    expect(isNextJsRouteFile('app/utils/helper.ts')).toBe(false)
    expect(isNextJsRouteFile('app/lib/db.ts')).toBe(false)
  })
})

describe('isFrameworkEntryPoint (composition)', () => {
  it('compose tous les predicates', () => {
    // Next.js
    expect(isFrameworkEntryPoint('app/page.tsx')).toBe(true)
    expect(isFrameworkEntryPoint('proxy.ts')).toBe(true)
    // Tool config
    expect(isFrameworkEntryPoint('vitest.config.ts')).toBe(true)
    // Test
    expect(isFrameworkEntryPoint('src/foo.test.ts')).toBe(true)
    // Script
    expect(isFrameworkEntryPoint('scripts/build.ts')).toBe(true)
    // OSS layout
    expect(isFrameworkEntryPoint('examples/foo.ts')).toBe(true)
    // Suffix
    expect(isFrameworkEntryPoint('foo.examples.ts')).toBe(true)
  })

  it('does NOT match regular source files', () => {
    expect(isFrameworkEntryPoint('lib/utils.ts')).toBe(false)
    expect(isFrameworkEntryPoint('src/components/Button.tsx')).toBe(false)
    expect(isFrameworkEntryPoint('packages/x/src/index.ts')).toBe(false)
  })
})
