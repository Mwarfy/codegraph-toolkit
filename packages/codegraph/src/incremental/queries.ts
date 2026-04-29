/**
 * Incremental queries — inputs et helpers de contexte partagés entre
 * détecteurs Salsa-isés.
 *
 * Sémantique :
 *   - `fileContent(path)` : input string. Set au début de chaque `analyze()`
 *     incremental avec le contenu courant du fichier. Si le contenu n'a
 *     pas changé (Object.is), le revision marker `changedAt` ne bouge
 *     pas, donc tous les downstream skippent leur recompute.
 *
 *   - `projectFiles(label)` : input string[]. La liste des fichiers
 *     analysés. Aggregator queries (allEnvUsage, allOauthScopeLiterals)
 *     itèrent dessus. Sentinel passe ~600 fichiers, label='all'.
 *
 *   - Project context : le ts-morph Project reste GLOBAL (compromis
 *     Sprint 2). Set via `setIncrementalContext()` au début de chaque
 *     `analyze()` incremental. Les queries qui ont besoin du SourceFile
 *     l'accèdent via `getIncrementalProject()`.
 *
 *     Important : Salsa ne cache pas le SourceFile lui-même (risque
 *     stale Project entre runs avec un nouveau Project). Les queries
 *     cachent leur RÉSULTAT extrait (ex: EnvVarReader[]) qui est
 *     immutable. La dépendance sur `fileContent(path)` suffit à
 *     invalider proprement quand le contenu change.
 */

import type { Project } from 'ts-morph'
import { input } from '@liby/salsa'
import { sharedDb as db } from './database.js'

// ─── Inputs Salsa ─────────────────────────────────────────────────────

/** Contenu brut d'un fichier (lu via fs au début de chaque analyze). */
export const fileContent = input<string, string>(db, 'fileContent')

/** Liste des fichiers analysés. Label conventionnel : 'all'. */
export const projectFiles = input<string, readonly string[]>(db, 'projectFiles')

// ─── Project context (hors-Salsa, module-level) ───────────────────────

let currentProject: Project | null = null
let currentRootDir: string = ''

export interface IncrementalContext {
  project: Project
  rootDir: string
}

export function setIncrementalContext(ctx: IncrementalContext): void {
  currentProject = ctx.project
  currentRootDir = ctx.rootDir
}

export function getIncrementalProject(): Project {
  if (!currentProject) {
    throw new Error(
      '[incremental] No Project set. Call setIncrementalContext() before any incremental query.',
    )
  }
  return currentProject
}

export function getIncrementalRootDir(): string {
  if (!currentRootDir) {
    throw new Error(
      '[incremental] No rootDir set. Call setIncrementalContext() before any incremental query.',
    )
  }
  return currentRootDir
}
