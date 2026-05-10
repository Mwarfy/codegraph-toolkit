// ADR-027
/**
 * Content-addressed hash des inputs qui déterminent l'output d'un
 * `codegraph analyze`. Permet de vérifier qu'un snapshot stocké est
 * encore valide pour le working tree courant sans relancer l'analyze.
 *
 * Trois inputs entrent dans le hash :
 *   1. `tooling`  — version de `@liby-tools/codegraph` (suffixe `-dev`
 *                  si on tourne depuis un workspace local)
 *   2. `config`   — sha256 du contenu de `codegraph.config.{json,ts,js}`
 *                  (null si pas de fichier de config présent)
 *   3. `sources`  — pour chaque fichier analysé : `{relpath}\t{sha256}`,
 *                  trié lexicographiquement pour le déterminisme
 *
 * Ce qui N'EST PAS hashé (volontairement) :
 *   - Le code des detectors (`packages/codegraph/src/**`) — capté
 *     indirectement via `toolingVersion`. En workspace dev, le suffixe
 *     `-dev` force le cache miss systématiquement.
 *   - Les ADRs (`docs/adr/**`) — n'influent pas sur le snapshot
 *     (ils alimentent uniquement le brief, pipeline distinct).
 *   - `package.json` — capté via `toolingVersion`.
 *
 * Phase 2 d'ADR-027.
 */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CodeGraphConfig } from '../core/types.js'

const CONFIG_CANDIDATES = [
  'codegraph.config.json',
  'codegraph.config.ts',
  'codegraph.config.js',
]

export interface InputHashContext {
  toolingVersion: string
  configHash: string | null
  fileCount: number
}

export interface InputHashResult {
  hash: string
  ctx: InputHashContext
}

/**
 * Calcule le inputHash pour un set de fichiers analysés.
 *
 * `filePaths` doit être la liste exhaustive des fichiers que
 * `analyze` a effectivement consommés (typiquement le retour de
 * `discoverFiles(rootDir, include, exclude)`). Chaque entrée est un
 * path relatif au `rootDir` (format émis par `file-discovery.ts`).
 * Les chemins absolus sont aussi acceptés (resolved vers relpath).
 */
export async function computeInputHash(
  config: CodeGraphConfig,
  filePaths: readonly string[],
): Promise<InputHashResult> {
  const toolingVersion = await readToolingVersion()
  const configHash = await hashConfigFile(config.rootDir)
  const fileLines = await hashSourceFiles(config.rootDir, filePaths)

  const composite =
    `tooling:${toolingVersion}\n` +
    `config:${configHash ?? ''}\n` +
    fileLines.join('\n')

  return {
    hash: sha256(composite),
    ctx: {
      toolingVersion,
      configHash,
      fileCount: fileLines.length,
    },
  }
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Lit la version de `@liby-tools/codegraph` depuis son package.json
 * compilé. En workspace mode (le dist vit dans le repo source), append
 * "-dev" pour forcer cache miss automatique pendant le dev du toolkit
 * — l'humain peut bypass via `CODEGRAPH_FRESH=1` ou suppression du
 * snapshot.
 */
async function readToolingVersion(): Promise<string> {
  let version = '0.0.0'
  let isWorkspace = false
  try {
    // Ce module est compilé dans `packages/codegraph/dist/incremental/input-hash.js`,
    // donc son package.json est à `../../package.json`.
    const here = path.dirname(fileURLToPath(import.meta.url))
    const pkgPath = path.resolve(here, '../../package.json')
    const raw = await fs.readFile(pkgPath, 'utf-8')
    const pkg = JSON.parse(raw) as { version?: string }
    version = pkg.version ?? '0.0.0'
    // Heuristique workspace : on a un répertoire src/ frère du dist/.
    isWorkspace = await fileExists(path.resolve(here, '../../src'))
  } catch {
    /* fallback to defaults */
  }
  return isWorkspace ? `${version}-dev` : version
}

async function hashConfigFile(rootDir: string): Promise<string | null> {
  for (const name of CONFIG_CANDIDATES) {
    const p = path.join(rootDir, name)
    try {
      const content = await fs.readFile(p, 'utf-8')
      return sha256(content)
    } catch {
      /* try next candidate */
    }
  }
  return null
}

async function hashSourceFiles(
  rootDir: string,
  filePaths: readonly string[],
): Promise<string[]> {
  // I/O parallèle : fs.readFile est I/O-bound, await sequentiel sur N
  // fichiers serait inutilement lent.
  const lines = await Promise.all(
    filePaths.map(async (p) => {
      const relpath = path.isAbsolute(p) ? path.relative(rootDir, p) : p
      const abs = path.isAbsolute(p) ? p : path.join(rootDir, p)
      try {
        const content = await fs.readFile(abs)
        return `${relpath}\t${sha256(content)}`
      } catch {
        // Fichier disparu entre discover et hash : on l'inclut quand même
        // avec hash vide pour signaler son absence dans le composite.
        return `${relpath}\t`
      }
    }),
  )
  // Tri lex stable — clé du déterminisme par construction.
  return lines.sort()
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}
