// ADR-007
/**
 * Project ts-morph cache (Sprint 5.2) — réutilise le Project entre
 * appels successifs d'`analyze()` dans le même process.
 *
 * createSharedProject() coûte ~3-5s sur Sentinel (parsing tsconfig +
 * addSourceFile pour ~600 fichiers + AST parse à la demande). Le
 * réutiliser quand rootDir + tsconfig sont identiques élimine ce coût
 * sur les runs warm.
 *
 * Invalidation :
 *   - rootDir change → jeter le cache, créer un nouveau Project
 *   - tsConfigPath change → idem
 *   - Fichier modifié (mtime bouge) → refresh le SourceFile via
 *     replaceWithText() ; l'AST se reparse à la demande sur le nouveau
 *     contenu
 *   - Fichier ajouté → addSourceFileAtPath
 *   - Fichier retiré → removeSourceFile
 *
 * Module-level state, pas thread-safe (Node main loop sync OK).
 */

import { Project } from 'ts-morph'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { createSharedProject } from '../extractors/unused-exports.js'

interface CachedProject {
  project: Project
  rootDir: string
  tsConfigPath: string | undefined
  fileSet: Set<string>
}

let cached: CachedProject | null = null

/**
 * Récupère un Project ts-morph adapté à `(rootDir, files, tsConfigPath)`.
 * Si le cache est compatible (mêmes rootDir + tsConfigPath), il est
 * réutilisé après synchronisation de l'ensemble de fichiers + refresh
 * des SourceFile dont le mtime a bougé depuis `previousMtimes`.
 *
 * @param previousMtimes  Map<relPath, mtimeMs>. Pour chaque fichier
 *   présent dans cette map ET dans le cache, on compare avec le mtime
 *   courant ; si différent, on `replaceWithText(content)` pour
 *   refresher l'AST. Un fichier sans entrée → considéré comme "déjà à
 *   jour" (1er run = pas de mtimeCache rempli).
 */
export async function getOrBuildSharedProject(
  rootDir: string,
  files: string[],
  tsConfigPath: string | undefined,
  previousMtimes: Map<string, number>,
  fileCache: Map<string, string>,
): Promise<Project> {
  if (!isCacheCompatible(rootDir, tsConfigPath)) {
    return rebuildAndCacheProject(rootDir, files, tsConfigPath)
  }

  const c = cached!
  const newFileSet = new Set(files)

  applyAddedFiles(c.project, rootDir, files, c.fileSet)
  applyRemovedFiles(c.project, rootDir, c.fileSet, newFileSet)
  await applyModifiedFiles(c.project, rootDir, files, c.fileSet, previousMtimes, fileCache)

  c.fileSet = newFileSet
  return c.project
}

function isCacheCompatible(rootDir: string, tsConfigPath: string | undefined): boolean {
  return cached !== null
    && cached.rootDir === rootDir
    && cached.tsConfigPath === tsConfigPath
}

function rebuildAndCacheProject(
  rootDir: string,
  files: string[],
  tsConfigPath: string | undefined,
): Project {
  const project = createSharedProject(rootDir, files, tsConfigPath)
  cached = { project, rootDir, tsConfigPath, fileSet: new Set(files) }
  return project
}

/** Files added : addSourceFileAtPath. Tolère parse errors (file restera hors). */
function applyAddedFiles(
  project: Project,
  rootDir: string,
  files: string[],
  oldFileSet: Set<string>,
): void {
  for (const f of files) {
    if (oldFileSet.has(f)) continue
    try {
      project.addSourceFileAtPath(path.join(rootDir, f))
    } catch { /* parse fail (syntax error, race delete) — file hors-Project */ }
  }
}

/** Files removed : removeSourceFile. */
function applyRemovedFiles(
  project: Project,
  rootDir: string,
  oldFileSet: Set<string>,
  newFileSet: Set<string>,
): void {
  for (const f of oldFileSet) {
    if (newFileSet.has(f)) continue
    const sf = project.getSourceFile(path.join(rootDir, f))
    if (sf) project.removeSourceFile(sf)
  }
}

/**
 * Files modified (mtime changé depuis previousMtimes) : replaceWithText pour
 * invalider l'AST cache de ts-morph. Lit le contenu via fileCache si possible
 * sinon fs. 1er run (no previousMtime) → no-op.
 */
async function applyModifiedFiles(
  project: Project,
  rootDir: string,
  files: string[],
  oldFileSet: Set<string>,
  previousMtimes: Map<string, number>,
  fileCache: Map<string, string>,
): Promise<void> {
  for (const f of files) {
    if (!oldFileSet.has(f)) continue                 // déjà ajouté, AST frais
    const prevMtime = previousMtimes.get(f)
    if (prevMtime === undefined) continue            // 1er run : skip

    const absPath = path.join(rootDir, f)
    // await-ok: incremental run touche peu de files (delta), séquentiel OK
    const mtime = await readMtimeOrUndefined(absPath)
    if (mtime === undefined || mtime === prevMtime) continue

    await refreshSourceFile(project, absPath, f, fileCache)
  }
}

async function readMtimeOrUndefined(absPath: string): Promise<number | undefined> {
  try {
    const stat = await fs.stat(absPath)
    return stat.mtimeMs
  } catch {
    return undefined
  }
}

async function refreshSourceFile(
  project: Project,
  absPath: string,
  f: string,
  fileCache: Map<string, string>,
): Promise<void> {
  const sf = project.getSourceFile(absPath)
  if (!sf) {
    try { project.addSourceFileAtPath(absPath) } catch { /* parse fail */ }
    return
  }
  let content = fileCache.get(f)
  if (content === undefined) {
    // await-ok: cache miss read, séquentiel OK (delta typique petit)
    try { content = await fs.readFile(absPath, 'utf-8') } catch { content = '' }
    fileCache.set(f, content)
  }
  sf.replaceWithText(content)
}

/** Force-jeter le cache. Utile pour tests ou commande CLI `--cold`. */
export function resetProjectCache(): void {
  cached = null
}
