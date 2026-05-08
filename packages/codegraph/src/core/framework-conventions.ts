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
  'middleware', 'instrumentation', 'instrumentation-client',
  // Metadata files
  'opengraph-image', 'twitter-image', 'icon', 'apple-icon',
  'sitemap', 'robots', 'manifest',
])

// Basenames acceptés n'importe où dans l'arbre (root-level Next.js).
const NEXTJS_ROOT_BASENAMES = new Set([
  'middleware', 'instrumentation', 'instrumentation-client',
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
  // Test runners
  'vitest.config', 'vite.config', 'jest.config', 'playwright.config',
  // CSS / build
  'tailwind.config', 'postcss.config', 'tsup.config', 'rollup.config',
  // Frameworks
  'next.config', 'nuxt.config', 'astro.config', 'svelte.config',
  // ORM
  'drizzle.config',
  // Sentry — chargés implicitement par @sentry/nextjs et @sentry/node
  'sentry.client.config', 'sentry.server.config', 'sentry.edge.config',
  // Expo
  'app.config', 'metro.config', 'babel.config',
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

// ─── Aggregate ──────────────────────────────────────────────────────────────

/**
 * `true` ssi `filePath` est un entry-point implicite chargé par un
 * framework/runtime, donc à exclure de la classification "orphan".
 *
 * Combine Next.js App Router (page/layout/route/middleware/...),
 * Expo Router (mobile/app/...), et tous les fichiers de config outillage
 * (next.config, vitest.config, sentry.*.config, ...).
 */
export function isFrameworkEntryPoint(filePath: string): boolean {
  return isNextJsRouteFile(filePath)
      || isExpoRouterFile(filePath)
      || isToolConfigFile(filePath)
}
