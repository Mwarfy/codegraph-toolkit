// ADR-002: config-driven obligatoire, pas de hardcoded projet
/**
 * Loader de `.codegraph-toolkit.json` à la racine du projet consommateur.
 *
 * Schéma stable. Defaults raisonnables pour qu'un projet neuf fonctionne sans
 * config explicite. Le `rootDir` est résolu en absolu après parsing.
 */

import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { z } from 'zod'

const ConfigSchema = z.object({
  rootDir: z.string().default('.'),
  adrDir: z.string().default('docs/adr'),
  srcDirs: z.array(z.string()).default(['src']),
  tsconfigPath: z.string().default('tsconfig.json'),
  briefPath: z.string().default('CLAUDE-CONTEXT.md'),
  anchorMarkerExtensions: z.array(z.string()).default(['ts', 'tsx', 'sh', 'sql']),
  skipDirs: z.array(z.string()).default([
    'node_modules', 'dist', '.next', '.codegraph', 'coverage', '.git',
  ]),
  hubThreshold: z.number().default(15),
  invariantTestPaths: z.array(z.string()).default([]),
  /**
   * Sections markdown projet-spécifiques injectées dans le brief généré.
   * Permet à un projet de garder ses propres références (liens vers MAP.md,
   * notes sur les hooks Claude Code, etc.) sans forker le toolkit.
   */
  briefCustomSections: z.array(z.object({
    placement: z.enum(['after-anchored-files', 'after-invariant-tests', 'after-recent-activity']),
    markdown: z.string(),
  })).default([]),
  codegraph: z.object({
    configPath: z.string().default('codegraph.config.json'),
  }).optional(),
})

export type AdrToolkitConfig = z.infer<typeof ConfigSchema>

export const CONFIG_FILENAME = '.codegraph-toolkit.json'

/**
 * Charge la config depuis `<rootDir>/.codegraph-toolkit.json`. Fichier absent
 * = on tourne sur les defaults. `rootDir` du résultat est toujours absolu.
 */
export async function loadConfig(rootDir: string = process.cwd()): Promise<AdrToolkitConfig> {
  const configPath = path.join(rootDir, CONFIG_FILENAME)
  let raw: unknown = {}
  try {
    raw = JSON.parse(await readFile(configPath, 'utf-8'))
  } catch {
    // Fichier absent ou invalide → defaults
  }
  const parsed = ConfigSchema.parse(raw)
  parsed.rootDir = path.resolve(rootDir, parsed.rootDir)
  return parsed
}
