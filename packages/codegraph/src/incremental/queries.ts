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
import { input, type InputQuery, type QueryKey } from '@liby/salsa'
import { sharedDb as db } from './database.js'

// ─── Inputs Salsa ─────────────────────────────────────────────────────

/** Contenu brut d'un fichier (lu via fs au début de chaque analyze). */
export const fileContent = input<string, string>(db, 'fileContent')

/** Liste des fichiers analysés. Label conventionnel : 'all'. */
export const projectFiles = input<string, readonly string[]>(db, 'projectFiles')

/**
 * mtime tracking pour skip de re-lecture / re-set des fileContent
 * inchangés entre runs (Sprint 5.1). Module-level — partagé avec le
 * sharedDb via le même process.
 *
 * Lifecycle : analyze() peut appeler `getMtimeCache()` pour comparer
 * avec mtime fs.stat. Si même mtime → skip readFile + skip
 * fileContent.set (l'ancienne valeur reste en cell, revision pas
 * bumpée pour ce fichier).
 */
const mtimeCache = new Map<string, number>()

export function getCachedMtime(filePath: string): number | undefined {
  return mtimeCache.get(filePath)
}

export function setCachedMtime(filePath: string, mtime: number): void {
  mtimeCache.set(filePath, mtime)
}

export function clearMtimeCache(): void {
  mtimeCache.clear()
}

/** Snapshot read-only du mtime cache, utilisé par la persistence Sprint 7. */
export function getMtimeMap(): Map<string, number> {
  return new Map(mtimeCache)
}

/** Restaure le mtime cache depuis un snapshot persisté (Sprint 7). */
export function loadMtimeMap(snapshot: Map<string, number>): void {
  mtimeCache.clear()
  for (const [k, v] of snapshot) mtimeCache.set(k, v)
}

/**
 * Sprint 5.3 — Skip-set quand la valeur est deep-equal à la précédente.
 *
 * Salsa bump la revision sur chaque `input.set()` même si le contenu
 * est équivalent (Object.is sur un nouvel array → false). Pour les
 * inputs "lourds" set à chaque run (graphEdges, typedCalls, manifests,
 * sqlDefaults), ça invalide tous les agrégats globaux qui en dépendent.
 *
 * Solution : avant le set, comparer une signature JSON de la valeur
 * précédente. Si identique, skip → la cell garde son `changedAt`,
 * downstream skip aussi.
 *
 * Trade-off : JSON.stringify coûte O(n) sur la value. Pour Sentinel,
 * 750 callEdges + 521 sigs = ~10ms. Acceptable pour gagner ~1-2s sur
 * l'invalidation downstream.
 */
const inputSignatures = new Map<string, string>()

export function setInputIfChanged<K extends QueryKey, V>(
  inputQuery: InputQuery<K, V>,
  key: K,
  value: V,
): boolean {
  const sigKey = `${inputQuery.id}:${String(key)}`
  const sig = JSON.stringify(value)
  const prev = inputSignatures.get(sigKey)
  if (prev === sig) return false
  inputSignatures.set(sigKey, sig)
  inputQuery.set(key, value)
  return true
}

export function clearInputSignatures(): void {
  inputSignatures.clear()
}

/**
 * Manifests `package.json` actifs (au moins 1 fichier dans leur scope).
 * La découverte est async (lecture filesystem), faite dans `analyze()`.
 * On stocke le résultat ici comme input — l'invalidation est totale à
 * chaque set, mais c'est OK : la discovery ne change quasi jamais
 * (rare modif d'un package.json).
 *
 * Object.is sur ce tableau de manifests sera FALSE entre runs (nouveau
 * tableau). Les détecteurs aval gèrent ça via leurs propres caches
 * per-file qui ne dépendent PAS de ce input.
 */
export const packageManifestsInput = input<string, unknown>(db, 'packageManifests')

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
