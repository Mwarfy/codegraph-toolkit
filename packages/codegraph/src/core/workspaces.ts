/**
 * Workspace detection — pnpm / npm / yarn workspaces + Lerna.
 *
 * Pourquoi : sans connaitre la structure workspace d'un monorepo, le toolkit
 * traite chaque package.json comme un scope independant. Consequences :
 *   - imports `@scope/internal` non resolus vers le workspace local →
 *     fichiers `packages/internal/src/index.ts` orphans
 *   - le detecteur `package-deps` flag les workspaces internes comme
 *     `declared-unused` (cf. trpc 257, tanstack-query 345)
 *
 * Sources de detection (premier trouve gagne) :
 *   1. `pnpm-workspace.yaml` (pnpm)
 *   2. `package.json#workspaces` (npm 7+, yarn classic + berry)
 *   3. `lerna.json#packages` (Lerna < 6 ; Lerna 7+ utilise pnpm/yarn)
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export interface WorkspaceEntry {
  /** Nom du package depuis son `package.json#name` (ex: `@trpc/server`). */
  name: string
  /** Chemin relatif depuis `rootDir` (ex: `packages/server`). */
  relPath: string
  /** Champ `main` du package.json. */
  main?: string
  /** Champ `types` ou `typings`. */
  types?: string
  /** Champ `bin` (string ou map). */
  bin?: string | Record<string, string>
  /** Champ `exports` (string ou map). */
  exports?: unknown
}

export interface WorkspaceMap {
  /** Map du nom (`@scope/name`) vers son entry. */
  byName: Map<string, WorkspaceEntry>
  /** Liste des relPath (preserve l'ordre de detection). */
  paths: string[]
}

const EMPTY_WORKSPACES: WorkspaceMap = { byName: new Map(), paths: [] }

export async function detectWorkspaces(rootDir: string): Promise<WorkspaceMap> {
  const patterns = await loadWorkspacePatterns(rootDir)
  if (patterns.length === 0) return EMPTY_WORKSPACES

  const entries: WorkspaceEntry[] = []
  for (const pattern of patterns) {
    const dirs = await expandGlob(rootDir, pattern)
    for (const dir of dirs) {
      const entry = await readWorkspacePackage(rootDir, dir)
      if (entry) entries.push(entry)
    }
  }

  const byName = new Map<string, WorkspaceEntry>()
  const paths: string[] = []
  for (const e of entries) {
    if (!byName.has(e.name)) byName.set(e.name, e)
    paths.push(e.relPath)
  }
  return { byName, paths }
}

async function loadWorkspacePatterns(rootDir: string): Promise<string[]> {
  // 1. pnpm
  const pnpmYaml = await readFileSafe(path.join(rootDir, 'pnpm-workspace.yaml'))
  if (pnpmYaml) {
    const ps = parsePnpmWorkspaceYaml(pnpmYaml)
    if (ps.length > 0) return ps
  }
  // 2. npm/yarn workspaces dans package.json
  const rootPkg = await readJsonSafe<{ workspaces?: string[] | { packages?: string[] } }>(
    path.join(rootDir, 'package.json'),
  )
  if (rootPkg?.workspaces) {
    const ws = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : rootPkg.workspaces.packages
    if (Array.isArray(ws) && ws.length > 0) return ws
  }
  // 3. Lerna
  const lerna = await readJsonSafe<{ packages?: string[] }>(path.join(rootDir, 'lerna.json'))
  if (lerna?.packages && lerna.packages.length > 0) return lerna.packages
  return []
}

/**
 * Parser minimal pour `pnpm-workspace.yaml` (structure simple, stable).
 *
 *   packages:
 *     - 'packages/*'
 *     - 'apps/*'
 *     - '!**\/test/**'  (exclusions, ignorees ici)
 */
function parsePnpmWorkspaceYaml(content: string): string[] {
  const out: string[] = []
  const lines = content.split('\n')
  let inPackages = false
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trimEnd()
    if (/^packages:\s*$/.test(line)) {
      inPackages = true
      continue
    }
    if (inPackages) {
      const m = /^\s+-\s+['"]?([^'"\n]+?)['"]?\s*$/.exec(line)
      if (m) {
        const pat = m[1]
        if (!pat.startsWith('!')) out.push(pat)
      } else if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('\t')) {
        inPackages = false
      }
    }
  }
  return out
}

/**
 * Expand un glob style `packages/*` ou `packages/**\/*`. Supporte :
 *   - segments litteraux (`packages`)
 *   - `*` = exactement un segment (sub-directory direct)
 *   - `**` = zero ou plusieurs segments (descente recursive)
 *
 * On ne descend pas dans `node_modules` ni les dotdirs. Filtre final :
 * un workspace doit contenir un `package.json` (verifie par
 * `readWorkspacePackage`).
 */
async function expandGlob(rootDir: string, pattern: string): Promise<string[]> {
  if (!pattern.includes('*')) {
    const abs = path.join(rootDir, pattern)
    return (await isDir(abs)) ? [pattern] : []
  }
  const segments = pattern.split('/')
  let candidates = ['']
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (seg === '*') {
      candidates = await expandSingleStar(rootDir, candidates)
    } else if (seg === '**') {
      candidates = await expandDoubleStar(rootDir, candidates)
    } else {
      candidates = candidates.map((c) => (c ? `${c}/${seg}` : seg))
      // Verifie que le segment litteral existe quand il succede a un glob
      candidates = await asyncFilter(candidates, (c) => isDir(path.join(rootDir, c)))
    }
  }
  return candidates
}

async function expandSingleStar(rootDir: string, candidates: string[]): Promise<string[]> {
  const next: string[] = []
  for (const c of candidates) {
    const abs = path.join(rootDir, c)
    const sub = await readdirSafe(abs)
    for (const name of sub) {
      if (skipDirName(name)) continue
      if (await isDir(path.join(abs, name))) {
        next.push(c ? `${c}/${name}` : name)
      }
    }
  }
  return next
}

/**
 * `**` : retourne tous les sous-dirs (recursif), incluant le dir courant
 * (zero segments). Cap profondeur a 6 pour eviter les explosions.
 */
async function expandDoubleStar(rootDir: string, candidates: string[]): Promise<string[]> {
  const all = new Set<string>(candidates)
  const queue = [...candidates]
  let depth = 0
  while (queue.length > 0 && depth < 6) {
    const next: string[] = []
    for (const c of queue) {
      const abs = path.join(rootDir, c)
      const sub = await readdirSafe(abs)
      for (const name of sub) {
        if (skipDirName(name)) continue
        if (await isDir(path.join(abs, name))) {
          const child = c ? `${c}/${name}` : name
          if (!all.has(child)) {
            all.add(child)
            next.push(child)
          }
        }
      }
    }
    queue.length = 0
    queue.push(...next)
    depth++
  }
  return Array.from(all)
}

function skipDirName(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules' || name === 'dist' || name === 'build'
}

async function asyncFilter<T>(items: T[], pred: (t: T) => Promise<boolean>): Promise<T[]> {
  const out: T[] = []
  for (const item of items) {
    if (await pred(item)) out.push(item)
  }
  return out
}

async function readWorkspacePackage(rootDir: string, relDir: string): Promise<WorkspaceEntry | null> {
  const pkgPath = path.join(rootDir, relDir, 'package.json')
  const pkg = await readJsonSafe<{
    name?: string
    main?: string
    types?: string
    typings?: string
    bin?: string | Record<string, string>
    exports?: unknown
    private?: boolean
  }>(pkgPath)
  if (!pkg?.name) return null
  return {
    name: pkg.name,
    relPath: relDir.replace(/\\/g, '/'),
    ...(pkg.main ? { main: pkg.main } : {}),
    ...(pkg.types || pkg.typings ? { types: pkg.types ?? pkg.typings } : {}),
    ...(pkg.bin ? { bin: pkg.bin } : {}),
    ...(pkg.exports !== undefined ? { exports: pkg.exports } : {}),
  }
}

// ─── Helpers I/O ────────────────────────────────────────────────────────────

async function readFileSafe(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf-8')
  } catch {
    return null
  }
}

async function readJsonSafe<T>(p: string): Promise<T | null> {
  const raw = await readFileSafe(p)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p)
    return st.isDirectory()
  } catch {
    return false
  }
}

async function readdirSafe(p: string): Promise<string[]> {
  try {
    return await fs.readdir(p)
  } catch {
    return []
  }
}

// ─── Entry-point classification ─────────────────────────────────────────────

/**
 * Liste des fichiers entry-point publics pour un workspace : main, types,
 * exports, bin. Tous les chemins sont relatifs au `rootDir`.
 *
 * Si aucun champ n'est defini, fallback sur les conventions :
 *   - `<relPath>/index.ts`
 *   - `<relPath>/src/index.ts`
 */
export function workspaceEntryFiles(ws: WorkspaceEntry): string[] {
  const out = new Set<string>()
  const add = (p: string | undefined): void => {
    if (!p) return
    const rel = p.startsWith('./') ? p.slice(2) : p
    addSourceCandidates(`${ws.relPath}/${rel}`, out)
  }
  add(ws.main)
  add(ws.types)
  if (typeof ws.bin === 'string') add(ws.bin)
  else if (ws.bin && typeof ws.bin === 'object') {
    for (const v of Object.values(ws.bin)) add(v)
  }
  if (typeof ws.exports === 'string') add(ws.exports)
  else if (ws.exports && typeof ws.exports === 'object') {
    collectExportPaths(ws.exports as Record<string, unknown>, add)
  }
  // Conventions fallback
  add('index.ts')
  add('index.tsx')
  add('src/index.ts')
  add('src/index.tsx')
  return Array.from(out)
}

/**
 * Map un chemin d'export (genre `dist/foo.mjs` vu dans package.json#exports)
 * vers ses candidats source TypeScript correspondants. Le toolkit analyse
 * `src/`, pas `dist/` — sans cette heuristique, exports pointe vers fichiers
 * inexistants dans l'analyse et les vrais sources passent orphans.
 *
 * Heuristique :
 *   1. Garde le chemin tel quel (cas `src/foo.ts` direct).
 *   2. Si le chemin contient `dist/` ou `build/` ou `lib/`, remplace par
 *      `src/` ET swap extension .{m,c,}js → .{m,c,}ts (+ .tsx fallback).
 *   3. Genere les variantes d'extension classiques.
 */
function addSourceCandidates(filePath: string, out: Set<string>): void {
  out.add(filePath)
  // Swap dist/build/lib → src
  const distPattern = /\/(?:dist|build|lib)\//
  if (distPattern.test(filePath)) {
    const srcPath = filePath.replace(distPattern, '/src/')
    out.add(srcPath)
    addExtensionVariants(srcPath, out)
  }
  addExtensionVariants(filePath, out)
}

function addExtensionVariants(filePath: string, out: Set<string>): void {
  // Si extension JS, ajoute aussi les variantes TS.
  const jsExtRe = /\.(?:m?js|cjs|jsx)$/
  if (jsExtRe.test(filePath)) {
    out.add(filePath.replace(/\.mjs$/, '.mts'))
    out.add(filePath.replace(/\.cjs$/, '.cts'))
    out.add(filePath.replace(/\.js$/, '.ts'))
    out.add(filePath.replace(/\.jsx$/, '.tsx'))
    out.add(filePath.replace(/\.m?js$/, '.ts'))
    out.add(filePath.replace(/\.m?js$/, '.tsx'))
  }
  // Si extension de declaration (.d.ts variants), strip vers la source.
  const dtsExtRe = /\.d\.(?:m?ts|cts)$/
  if (dtsExtRe.test(filePath)) {
    out.add(filePath.replace(/\.d\.mts$/, '.ts'))
    out.add(filePath.replace(/\.d\.cts$/, '.ts'))
    out.add(filePath.replace(/\.d\.ts$/, '.ts'))
    out.add(filePath.replace(/\.d\.(?:m?ts|cts)$/, '.tsx'))
  }
}

function collectExportPaths(node: unknown, add: (s: string) => void): void {
  if (typeof node === 'string') {
    add(node)
    return
  }
  if (node && typeof node === 'object') {
    for (const v of Object.values(node as Record<string, unknown>)) {
      collectExportPaths(v, add)
    }
  }
}

/**
 * Construit le set des entry-points workspace (path relatifs depuis rootDir).
 * Utilise par `framework-conventions.ts` pour empecher la classification
 * orphan sur les `index.ts` exposes via `package.json#main` / `exports`.
 */
export function buildWorkspaceEntryPointSet(map: WorkspaceMap): Set<string> {
  const set = new Set<string>()
  for (const ws of map.byName.values()) {
    for (const f of workspaceEntryFiles(ws)) set.add(f)
  }
  return set
}
