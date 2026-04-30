/**
 * Incremental env-usage — wrap Salsa autour du scan AST `process.env.X`.
 *
 * Architecture :
 *   - `envUsageOfFile(path)` : derived → EnvVarReader[] (avec varName).
 *     Dépend de `fileContent(path)`. Si le contenu d'un fichier change,
 *     seul ce fichier réparse.
 *   - `allEnvUsage(label)` : derived → EnvVarUsage[]. Agrège tous les
 *     `envUsageOfFile` pour les fichiers de `projectFiles(label)`,
 *     applique le tri + calcul de `isSecret`.
 *
 * NB : la liste de fichiers (`projectFiles`) est elle-même un input.
 * Si un fichier disparaît du projet, on `set` la nouvelle liste, ce qui
 * invalide `allEnvUsage` mais PAS les `envUsageOfFile(path)` des autres
 * fichiers. Cache hit per-file maximal.
 */

import { derived } from '@liby-tools/salsa'
import type { EnvVarUsage, EnvVarReader } from '../core/types.js'
import {
  scanEnvReadersInSourceFile,
  aggregateEnvReaders,
  DEFAULT_ENV_SECRET_TOKENS,
} from '../extractors/env-usage.js'
import { sharedDb as db } from './database.js'
import {
  fileContent,
  projectFiles,
  getIncrementalProject,
  getIncrementalRootDir,
} from './queries.js'
import * as path from 'node:path'

interface EnvReaderEntry {
  varName: string
  reader: EnvVarReader
}

/**
 * Lit le contenu via fileContent (dep Salsa) puis scanne le SourceFile
 * via le Project ts-morph global. Le Project est compagnon (hors-Salsa)
 * mais l'invalidation est correcte parce que Salsa rappellera ce derived
 * quand `fileContent(path)` change, et le Project reflète toujours le
 * contenu courant (Sentinel garantit Project.refreshFromFileSystem au
 * boot du analyze).
 */
export const envUsageOfFile = derived<string, EnvReaderEntry[]>(
  db, 'envUsageOfFile',
  (filePath) => {
    fileContent.get(filePath)  // dep tracking : invalidate when content changes
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) return []
    return scanEnvReadersInSourceFile(sf, filePath)
  },
)

export const allEnvUsage = derived<string, EnvVarUsage[]>(
  db, 'allEnvUsage',
  (label) => {
    const files = projectFiles.get(label)
    const byName = new Map<string, EnvVarReader[]>()
    for (const f of files) {
      for (const { varName, reader } of envUsageOfFile.get(f)) {
        if (!byName.has(varName)) byName.set(varName, [])
        byName.get(varName)!.push(reader)
      }
    }
    return aggregateEnvReaders(byName, DEFAULT_ENV_SECRET_TOKENS)
  },
)
