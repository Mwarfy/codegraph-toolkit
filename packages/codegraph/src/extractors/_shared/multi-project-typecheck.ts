/**
 * Multi-tsconfig TypeChecker support.
 *
 * Codegraph normally builds ONE shared ts-morph Project from a single
 * `tsconfigPath`. On a monorepo with several sub-projects (each with its
 * own tsconfig and path aliases — backend, frontend, packages/X), this
 * gives correct type-checking for files inside the picked sub-project,
 * but `any`/unresolved types for files in any other sub-project. That's
 * how morovar's `floating-promises` ended up flagging 6 sync `*.initialize`
 * calls in backend code while pointed at a frontend tsconfig.
 *
 * This helper discovers every `tsconfig.json` under rootDir and lazily
 * builds one ts-morph Project per sub-project. Detectors that need a
 * trustworthy TypeChecker for a specific file can route through
 * `getProjectForFile(relPath)`.
 *
 * Trade-off: memory ×N where N is the number of sub-projects. Each
 * Project is built lazily on first request — projects whose files are
 * never queried stay uncreated.
 */

import { Project, type SourceFile } from 'ts-morph'
import * as fs from 'node:fs'
import * as path from 'node:path'

export class MultiProjectTypeChecker {
  private cache = new Map<string, Project | null>()
  private subProjectRoots: string[]
  private readonly absRootDir: string
  private readonly allFiles: readonly string[]

  /** @param rootDir absolute project root
   *  @param allFiles rootDir-relative paths of files codegraph analyzes
   *         (used to scope sub-project Projects — we only load the files
   *         the rest of the analysis cares about, not everything the
   *         tsconfig would otherwise pull in)
   *  @param skipDirs paths (relative to rootDir, no leading slash) where
   *         we won't search for tsconfigs (typical: node_modules, dist) */
  constructor(rootDir: string, allFiles: readonly string[] = [], skipDirs: string[] = ['node_modules', 'dist', '.next', 'build', 'out', '.codegraph', '.git']) {
    this.absRootDir = rootDir
    this.allFiles = allFiles
    const found = discoverSubProjectRoots(rootDir, new Set(skipDirs))
      // Longest first → most specific match wins.
      .sort((a, b) => b.length - a.length)
    // No-op routing when the project has at most one tsconfig — the
    // shared Project is already the right (and only) TypeChecker.
    // Skipping here saves the per-file lookup + the lazy Project build.
    this.subProjectRoots = found.length <= 1 ? [] : found
  }

  /** Project rooted at the sub-project that contains the file, or null
   *  if no sub-project tsconfig was found. The caller can fall back to
   *  the shared single-tsconfig Project when null. */
  getProjectForFile(relPath: string): Project | null {
    const subRoot = this.findSubRootFor(relPath)
    if (subRoot === null) return null
    if (!this.cache.has(subRoot)) this.cache.set(subRoot, this.buildProject(subRoot))
    return this.cache.get(subRoot) ?? null
  }

  /** Convenience: source file lookup that returns the SourceFile from
   *  the correct sub-project. The path can be relative (rootDir-rooted)
   *  or absolute. Returns null if the file isn't in any sub-project. */
  getSourceFile(relPath: string): SourceFile | null {
    const project = this.getProjectForFile(relPath)
    if (!project) return null
    const abs = path.isAbsolute(relPath) ? relPath : path.join(this.absRootDir, relPath)
    return project.getSourceFile(abs) ?? null
  }

  private findSubRootFor(relPath: string): string | null {
    const norm = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
    for (const root of this.subProjectRoots) {
      if (root === '' || norm.startsWith(root + '/') || norm === root) return root
    }
    return null
  }

  private buildProject(subRoot: string): Project | null {
    const subRootAbs = subRoot === '' ? this.absRootDir : path.join(this.absRootDir, subRoot)
    const tsconfig = path.join(subRootAbs, 'tsconfig.json')
    try {
      // skipAddingFilesFromTsConfig=true : don't auto-load everything
      // the tsconfig would pull in. Add only the files codegraph cares
      // about (allFiles ∩ sub-project). Bail out early if no files
      // belong here — keeps cold-start cheap on monorepos where the
      // analysis only touches a couple of sub-projects.
      const prefix = subRoot === '' ? '' : subRoot + '/'
      const scoped = subRoot === ''
        ? this.allFiles
        : this.allFiles.filter((f) => f.startsWith(prefix))
      if (scoped.length === 0) return null
      const project = new Project({
        tsConfigFilePath: tsconfig,
        skipAddingFilesFromTsConfig: true,
      })
      for (const f of scoped) {
        try { project.addSourceFileAtPath(path.join(this.absRootDir, f)) }
        catch { /* skip unparseable */ }
      }
      // No `resolveSourceFileDependencies()` here — that walk parses
      // every transitive import and dominated cold-start. ts-morph
      // resolves lazily on the first query, which is enough for
      // getReturnType / getSymbol on the symbols we actually touch.
      return project
    } catch {
      return null
    }
  }
}

/** Module-level cache: same rootDir/skipDirs → same answer. Saves
 *  repeated filesystem walks across multiple analyze() runs on the
 *  same project (test fixtures call analyze 3× for byte-equivalence;
 *  the runtime regression test runs analyze 3× too). */
const _discoveryCache = new Map<string, string[]>()

/** Walk the directory tree under rootDir collecting any folder that
 *  has a `tsconfig.json` directly inside. Stops descending into skipDirs.
 *  Returns rootDir-relative paths (forward slashes, no trailing slash). */
function discoverSubProjectRoots(rootDir: string, skipDirs: Set<string>): string[] {
  const key = rootDir + '\0' + [...skipDirs].sort().join(',')
  const cached = _discoveryCache.get(key)
  if (cached) return cached
  const found = doDiscoverSubProjectRoots(rootDir, skipDirs)
  _discoveryCache.set(key, found)
  return found
}

function doDiscoverSubProjectRoots(rootDir: string, skipDirs: Set<string>): string[] {
  const found: string[] = []
  const walk = (absDir: string, relDir: string): void => {
    if (skipDirs.has(path.basename(absDir))) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }) }
    catch { return }
    let hasTsConfig = false
    for (const e of entries) {
      if (!e.isFile()) continue
      if (e.name === 'tsconfig.json') { hasTsConfig = true; break }
    }
    if (hasTsConfig) found.push(relDir)
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (e.name.startsWith('.') && e.name !== '.') continue
      if (skipDirs.has(e.name)) continue
      walk(path.join(absDir, e.name), relDir === '' ? e.name : `${relDir}/${e.name}`)
    }
  }
  walk(rootDir, '')
  return found
}
