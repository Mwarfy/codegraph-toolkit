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
  const sameContext =
    cached !== null &&
    cached.rootDir === rootDir &&
    cached.tsConfigPath === tsConfigPath

  if (!sameContext) {
    // Cache invalide ou inexistant : créer un Project frais.
    const project = createSharedProject(rootDir, files, tsConfigPath)
    cached = {
      project,
      rootDir,
      tsConfigPath,
      fileSet: new Set(files),
    }
    return project
  }

  const c = cached!
  const project = c.project
  const newFileSet = new Set(files)

  // Files added : addSourceFileAtPath
  for (const f of files) {
    if (c.fileSet.has(f)) continue
    const absPath = path.join(rootDir, f)
    try {
      project.addSourceFileAtPath(absPath)
    } catch { /* TS parse fail (syntax error, race delete) — file restera hors-Project, downstream tolerant */ }
  }

  // Files removed : removeSourceFile
  for (const f of c.fileSet) {
    if (newFileSet.has(f)) continue
    const absPath = path.join(rootDir, f)
    const sf = project.getSourceFile(absPath)
    if (sf) project.removeSourceFile(sf)
  }

  // Files modified (mtime changé depuis previousMtimes) : replaceWithText
  // pour invalider l'AST cache de ts-morph. On lit le contenu via
  // fileCache (déjà rempli par analyzer si dispo) sinon fs.
  for (const f of files) {
    if (!c.fileSet.has(f)) continue  // déjà ajouté plus haut, AST frais
    const prevMtime = previousMtimes.get(f)
    if (prevMtime === undefined) continue  // 1er run : ne rien faire

    const absPath = path.join(rootDir, f)
    let mtime: number | undefined
    try {
      const stat = await fs.stat(absPath)
      mtime = stat.mtimeMs
    } catch {
      mtime = undefined
    }
    if (mtime === undefined || mtime === prevMtime) continue

    const sf = project.getSourceFile(absPath)
    if (!sf) {
      try { project.addSourceFileAtPath(absPath) } catch { /* parse fail — laisse fileSet incohérent volontairement, prochain run rebuild */ }
      continue
    }
    let content = fileCache.get(f)
    if (content === undefined) {
      try { content = await fs.readFile(absPath, 'utf-8') } catch { content = '' }
      fileCache.set(f, content)
    }
    sf.replaceWithText(content)
  }

  c.fileSet = newFileSet
  return project
}

/** Force-jeter le cache. Utile pour tests ou commande CLI `--cold`. */
export function resetProjectCache(): void {
  cached = null
}
