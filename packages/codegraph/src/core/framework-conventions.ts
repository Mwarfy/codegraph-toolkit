/**
 * Framework convention detection — fichiers et exports lus par réflexion
 * par un runtime/framework (Next.js, Expo, Sentry, vitest...) plutôt que
 * par un import explicite.
 *
 * Fix : avant l'extraction de ce module, ces conventions étaient câblées
 * uniquement dans `extractors/unused-exports.ts`. Conséquence : la
 * classification orphan/entry-point dans `core/graph.ts` ignorait Next.js
 * App Router, Expo Router, Sentry et les configs implicites — un projet
 * Next.js typique se retrouvait avec un health score 50% pollué de faux
 * positifs.
 *
 * Source de vérité unique consommée par :
 *   - `core/graph.ts` → `isEntryPoint()` pour la status orphan
 *   - `extractors/unused-exports.ts` → whitelist d'exports framework
 */

// ─── Next.js App Router ─────────────────────────────────────────────────────
//
// Références :
//   https://nextjs.org/docs/app/api-reference/file-conventions
//   https://nextjs.org/docs/app/api-reference/file-conventions/metadata
//   https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config

export const NEXTJS_CONVENTION_EXPORTS = new Set([
  // Metadata API
  'metadata', 'generateMetadata',
  'viewport', 'generateViewport',
  // Route segment config
  'dynamic', 'dynamicParams', 'revalidate', 'fetchCache',
  'runtime', 'preferredRegion', 'maxDuration', 'experimental_ppr',
  // generateStaticParams pour les segments dynamiques
  'generateStaticParams',
  // Image/icon conventions (opengraph-image, twitter-image, icon, apple-icon)
  'alt', 'size', 'contentType',
])

export const NEXTJS_ROUTE_BASENAMES = new Set([
  'page', 'layout', 'template', 'loading', 'error',
  'global-error', 'not-found', 'default', 'route',
  // Root-level conventions (peuvent vivre hors de app/)
  'middleware', 'proxy', 'instrumentation', 'instrumentation-client',
  // Metadata files
  'opengraph-image', 'twitter-image', 'icon', 'apple-icon',
  'sitemap', 'robots', 'manifest',
])

// Basenames acceptés n'importe où dans l'arbre (root-level Next.js).
// `proxy` est ajouté pour Next.js 16 (remplace `middleware.ts`).
const NEXTJS_ROOT_BASENAMES = new Set([
  'middleware', 'proxy', 'instrumentation', 'instrumentation-client',
])

/**
 * Un fichier est "route Next.js" si son basename correspond à une convention
 * (page, layout, route, middleware, etc.) ET qu'il est sous un répertoire
 * `app/` (App Router) — sauf middleware/instrumentation qui vivent à la
 * racine.
 */
export function isNextJsRouteFile(filePath: string): boolean {
  const basenameNoExt = (filePath.split('/').pop() ?? filePath)
    .replace(/\.(ts|tsx|js|jsx)$/, '')
  if (NEXTJS_ROOT_BASENAMES.has(basenameNoExt)) return true
  const inAppRouter = filePath.includes('/app/') || filePath.startsWith('app/')
  if (!inAppRouter) return false
  return NEXTJS_ROUTE_BASENAMES.has(basenameNoExt)
}

/**
 * Un export convention Next.js n'est pas "unused" même si personne ne l'importe —
 * le runtime Next le lit par réflexion depuis les fichiers de route.
 */
export function isNextJsFrameworkExport(filePath: string, symbolName: string): boolean {
  if (!isNextJsRouteFile(filePath)) return false
  if (symbolName === 'default') return true
  return NEXTJS_CONVENTION_EXPORTS.has(symbolName)
}

// ─── Expo Router ────────────────────────────────────────────────────────────
//
// Référence : https://docs.expo.dev/router/introduction/
//
// File-based routing similaire à Next.js mais sans la dichotomie
// page/layout/route — chaque fichier sous `app/` ou `mobile/app/` est
// un screen (file convention names entre parenthèses pour les groupes,
// brackets pour les params).

const EXPO_ROUTER_CONVENTION_BASENAMES = new Set([
  '_layout', '+not-found', '+native-intent', '+html',
])

/**
 * Un fichier est screen Expo Router si :
 *   - il est sous `app/` ou `mobile/app/` (au sens préfixe ou contient `/app/`)
 *   - ET son extension est .tsx/.jsx/.ts/.js
 *
 * Note : un projet peut héberger Expo dans `mobile/` (pattern monorepo
 * Happenin) ou `apps/mobile/`. On accepte les deux.
 */
export function isExpoRouterFile(filePath: string): boolean {
  const ext = filePath.match(/\.(tsx|jsx|ts|js)$/)
  if (!ext) return false
  // Doit être sous un dossier `app/` quelque part dans l'arbre.
  // On exige que `app/` soit précédé de `mobile/` ou `apps/mobile/`
  // pour ne pas confondre avec Next.js App Router.
  return /(?:^|\/)(?:mobile|apps\/mobile)\/app\//.test(filePath)
}

// ─── Tool / framework config files ──────────────────────────────────────────
//
// Configs lues par leur runner (vitest, next, sentry, etc.) — jamais
// importées par du code applicatif.

export const TOOL_CONFIG_BASENAMES = new Set([
  // Test runners — config + setup files (referenced by config, but config
  // is itself a tool-config file → setup chain n'est pas suivie)
  'vitest.config', 'vitest.setup', 'vitest.workspace',
  'vite.config',
  'jest.config', 'jest.setup',
  'playwright.config',
  // CSS / build / bundlers
  'tailwind.config', 'postcss.config', 'tsup.config', 'rollup.config',
  'tsdown.config',  // tsdown bundler (2025+, used by mcp-sdk & co.)
  'unbuild.config', // unbuild bundler
  'esbuild.config',
  // Frameworks
  'next.config', 'nuxt.config', 'astro.config', 'svelte.config',
  // Linters — ESLint flat config (eslint.config.{js,mjs,cjs,ts}) est lu
  // implicitement par eslint, jamais importé par du code applicatif.
  'eslint.config',
  // ORM
  'drizzle.config',
  // Sentry — chargés implicitement par @sentry/nextjs et @sentry/node
  'sentry.client.config', 'sentry.server.config', 'sentry.edge.config',
  // Expo
  'app.config', 'metro.config', 'babel.config',
  // Vercel — `vercel.ts` (2026, remplace vercel.json) lu par Vercel CLI
  'vercel',
])

export function isToolConfigFile(filePath: string): boolean {
  const basename = filePath.split('/').pop() ?? filePath
  const noExt = basename.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '')
  return TOOL_CONFIG_BASENAMES.has(noExt)
}

/**
 * Le `default` export d'un fichier de config outillage est lu par le
 * runner (vitest, vite, jest, etc.), pas par du code applicatif.
 */
export function isToolConfigExport(filePath: string, symbolName: string): boolean {
  if (symbolName !== 'default') return false
  return isToolConfigFile(filePath)
}

// ─── Test files ─────────────────────────────────────────────────────────────
//
// Tests sont lus par leur runner (vitest / jest / playwright) — jamais
// importés par du code applicatif. Sans ça, un projet sans
// `entryPoints: ["**/*.test.ts"]` configuré manuellement se retrouve avec
// tous ses tests classifiés orphan, ce qui cascade : les helpers de test
// utilisés UNIQUEMENT par ces tests deviennent eux aussi orphans.

const TEST_FILE_REGEX = /\.(?:test|spec)\.[mc]?[tj]sx?$/
const STORIES_FILE_REGEX = /\.stories\.[mc]?[tj]sx?$/
// `*.test-d.ts` = vitest type-only tests (charges par `vitest typecheck`)
const TYPE_TEST_REGEX = /\.test-d\.[mc]?ts$/
// `*.svelte.ts` = Svelte 5 runes/reactive files (charges par le compilateur Svelte)
const SVELTE_REACTIVE_REGEX = /\.svelte\.[mc]?ts$/
// `test-setup.ts` (variant generique de vitest.setup.ts/jest.setup.ts) =
// charge par le test runner via `setupFiles` config
const TEST_SETUP_REGEX = /(?:^|\/)test-setup\.[mc]?[tj]sx?$/

export function isTestEntryPoint(filePath: string): boolean {
  if (TEST_FILE_REGEX.test(filePath)) return true
  if (STORIES_FILE_REGEX.test(filePath)) return true
  if (TYPE_TEST_REGEX.test(filePath)) return true
  if (SVELTE_REACTIVE_REGEX.test(filePath)) return true
  if (TEST_SETUP_REGEX.test(filePath)) return true
  // `__tests__/` (jest convention) + `__testfixtures__/` (jscodeshift codemods) +
  // `__mocks__/` (vitest/jest manual mocks) anywhere in the tree
  if (filePath.includes('/__tests__/') || filePath.startsWith('__tests__/')) return true
  if (filePath.includes('/__testfixtures__/') || filePath.startsWith('__testfixtures__/')) return true
  if (filePath.includes('/__mocks__/') || filePath.startsWith('__mocks__/')) return true
  return false
}

// ─── Scripts ────────────────────────────────────────────────────────────────
//
// Convention `scripts/` directory à la racine = CLI scripts lancés via
// `npm run …` ou `node scripts/foo.ts`. Pas un import target — leur seul
// "importer" est le shell. Idem pour `bin/`.

export function isScriptEntryPoint(filePath: string): boolean {
  if (filePath.startsWith('scripts/') || filePath.includes('/scripts/')) return true
  if (filePath.startsWith('bin/') || filePath.includes('/bin/')) return true
  return false
}

// ─── OSS layout conventions ─────────────────────────────────────────────────
//
// Conventions universelles des projets open-source : repertoires qui
// contiennent du code "demonstration" / "benchmark" / "site doc" — chacun
// de leurs fichiers est un entry-point autonome charge directement par un
// runtime (node script, deno run, bun run, framework dev server pour
// `www/`), pas importe par d'autres fichiers de la lib.
//
// Sans ces conventions, un projet OSS typique se retrouve avec des
// dizaines a des centaines d'orphans (cf. OSS-AUDIT-2026-05-08 :
// tanstack-query 75 orphans `examples/`, trpc 67 + `www/` 30, etc.).

const OSS_LAYOUT_DIRS = new Set([
  'examples',      // standalone tutorials/demos shipped avec la lib
  'example',       // singulier (vite, next-forge)
  'benchmarks',    // perf comparisons, runners independants
  'benchmark',     // singulier
  'samples',       // synonyme examples (Microsoft repos)
  'demos',         // synonyme examples (Vue ecosystem)
  'demo',          // singulier
  'playground',    // exploration scripts (svelte-kit, solid)
  'playgrounds',   // pluriel (nuxt)
  'fixtures',      // test fixtures niveau racine (sans __ prefix)
  'runtime-tests', // hono pattern : tests par runtime cible (bun/deno/...)
  'perf-measures', // hono pattern : mesures perf
  'www',           // site docs Next.js classique des projets OSS
  'website',       // synonyme www (Docusaurus generally)
  'docs-site',     // variant explicite
  'site',          // variant minimal
])

// Suffix `*.examples.{ts,tsx}` — convention mcp-sdk et autres : fichiers
// d'exemples colocalises avec le source (alternative au dossier `examples/`).
const EXAMPLES_SUFFIX_REGEX = /\.examples\.[mc]?[tj]sx?$/
const BENCH_SUFFIX_REGEX = /\.bench\.[mc]?[tj]sx?$/

export function isOssLayoutEntryPoint(filePath: string): boolean {
  if (EXAMPLES_SUFFIX_REGEX.test(filePath)) return true
  if (BENCH_SUFFIX_REGEX.test(filePath)) return true
  const segments = filePath.split('/')
  // Match si l'un des segments du path est dans la liste — ex: `www/src/..`
  // OU `packages/something/examples/foo.ts`.
  for (const seg of segments) {
    if (OSS_LAYOUT_DIRS.has(seg)) return true
  }
  return false
}

// ─── Aggregate ──────────────────────────────────────────────────────────────

/**
 * `true` ssi `filePath` est un entry-point implicite chargé par un
 * framework/runtime, donc à exclure de la classification "orphan".
 *
 * Combine Next.js App Router (page/layout/route/middleware/proxy/...),
 * Expo Router (mobile/app/...), tous les fichiers de config outillage
 * (next.config, vitest.config, sentry.*.config, vercel.ts, ...), les
 * fichiers de test (vitest/jest/playwright/storybook + type tests +
 * fixtures + mocks), les scripts CLI (`scripts/`, `bin/`), et les layouts
 * OSS conventionnels (`examples/`, `benchmarks/`, `www/`, ...).
 */
export function isFrameworkEntryPoint(filePath: string): boolean {
  return isNextJsRouteFile(filePath)
      || isExpoRouterFile(filePath)
      || isToolConfigFile(filePath)
      || isTestEntryPoint(filePath)
      || isScriptEntryPoint(filePath)
      || isOssLayoutEntryPoint(filePath)
}
