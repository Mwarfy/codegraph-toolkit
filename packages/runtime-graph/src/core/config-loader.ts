/**
 * Config loader — résout `liby-runtime.config.ts` (ou .js/.json) depuis
 * le projet observé. Permet une approche declarative au lieu de
 * config CLI flag-by-flag.
 *
 * Resolution order :
 *   1. `<projectRoot>/liby-runtime.config.ts`
 *   2. `<projectRoot>/liby-runtime.config.js`
 *   3. `<projectRoot>/liby-runtime.config.json`
 *   4. `<projectRoot>/.libyrc.json` (alternative succinte)
 *   5. Aucun → defaults
 *
 * Le format TS est preferred — Zod-like type safety + autocompletion via
 * `defineConfig()` helper.
 *
 * Phase β scope : juste reader. Phase γ ajoutera schema validation
 * (Zod) + warnings sur conflict (driver dans config + --driver CLI flag).
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { RuntimeGraphConfig } from './types.js'

const CONFIG_BASENAMES = [
  'liby-runtime.config.ts',
  'liby-runtime.config.mts',
  'liby-runtime.config.js',
  'liby-runtime.config.mjs',
  'liby-runtime.config.json',
  '.libyrc.json',
]

export interface LoadedConfig {
  /** Path absolu du fichier config résolu (null si defaults). */
  path: string | null
  /** Config effective — defaults appliqués. */
  config: Required<Omit<RuntimeGraphConfig, 'projectRoot' | 'expectedTables' | 'expectedRoutes'>> &
          Pick<RuntimeGraphConfig, 'projectRoot' | 'expectedTables' | 'expectedRoutes'>
}

const DEFAULTS: Pick<
  Required<RuntimeGraphConfig>,
  'drivers'
> & {
  capture: NonNullable<RuntimeGraphConfig['capture']>
} = {
  drivers: [{ name: 'synthetic' }],
  capture: {
    sampleRate: 1.0,
    excludePaths: ['/health', '/metrics', '/favicon.ico'],
    excludePackages: [],
    enableAutoInstruments: true,
  },
}

/**
 * Résout le config file pour un projet, fallback sur defaults.
 * IMPORTANT — file resolution est best-effort, ne throw jamais
 * (Phase α : tolerant by default).
 */
export async function loadConfig(projectRoot: string): Promise<LoadedConfig> {
  for (const name of CONFIG_BASENAMES) {
    const candidate = path.join(projectRoot, name)
    try {
      await fs.access(candidate)
    } catch { continue }

    try {
      const config = await loadFile(candidate)
      return {
        path: candidate,
        config: applyDefaults(config, projectRoot),
      }
    } catch {
      // Config file existe mais load fail — Phase α : tomber sur defaults
      // pour être tolerant. β : log warning structuré.
      continue
    }
  }
  return {
    path: null,
    config: applyDefaults({} as RuntimeGraphConfig, projectRoot),
  }
}

async function loadFile(filePath: string): Promise<RuntimeGraphConfig> {
  if (filePath.endsWith('.json')) {
    const content = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(content) as RuntimeGraphConfig
  }
  // TS/JS via dynamic import. Pour TS files, l'utilisateur DOIT avoir
  // tsx ou ts-node configuré (ou compile à la volée).
  const url = pathToFileURL(filePath).toString()
  const mod = (await import(url)) as { default?: RuntimeGraphConfig } | RuntimeGraphConfig
  if ('default' in mod && mod.default) return mod.default
  return mod as RuntimeGraphConfig
}

function applyDefaults(
  config: RuntimeGraphConfig,
  projectRoot: string,
): LoadedConfig['config'] {
  return {
    projectRoot: config.projectRoot ?? projectRoot,
    factsOutDir: config.factsOutDir ?? path.join(projectRoot, '.codegraph/facts-runtime'),
    drivers: config.drivers && config.drivers.length > 0 ? config.drivers : DEFAULTS.drivers,
    capture: {
      sampleRate: config.capture?.sampleRate ?? DEFAULTS.capture.sampleRate,
      excludePaths: config.capture?.excludePaths ?? DEFAULTS.capture.excludePaths,
      excludePackages: config.capture?.excludePackages ?? DEFAULTS.capture.excludePackages,
      enableAutoInstruments: config.capture?.enableAutoInstruments ?? DEFAULTS.capture.enableAutoInstruments,
    },
    expectedTables: config.expectedTables,
    expectedRoutes: config.expectedRoutes,
  }
}

/**
 * Helper pour autocompletion / type safety dans un .ts config file :
 *
 *   import { defineConfig } from '@liby-tools/runtime-graph'
 *   export default defineConfig({
 *     drivers: [{ name: 'replay-tests' }],
 *     capture: { excludePaths: ['/internal/admin'] },
 *   })
 */
export function defineConfig(config: RuntimeGraphConfig): RuntimeGraphConfig {
  return config
}
