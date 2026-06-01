// ADR-005
/**
 * `codegraph affected <files...>` — BFS reverse depuis les fichiers
 * donnés pour lister tout ce qui est impacté transitivement par leurs
 * modifications.
 *
 * Extrait du god-file `cli/index.ts` (P2b split). La registration
 * `.command('affected')` reste dans `index.ts`, le handler + les
 * helpers BFS sont ici.
 *
 * Modes :
 *   - input vide → fallback `git diff --name-only HEAD`
 *   - `--include-indirect` : inclut event/queue/db-table edges
 *   - `--tests-glob` : scanne ces tests à la volée (regex import)
 *      pour les croiser avec affected — utile si la config codegraph
 *      exclut les tests du snapshot.
 */

import chalk from 'chalk'
import { loadSnapshot } from '../_shared.js'

export interface AffectedOpts {
  config?: string
  includeIndirect?: boolean
  maxDepth?: string
  testsOnly?: boolean
  testsGlob?: string
  json?: boolean
}

export async function runAffectedCommand(files: string[], opts: AffectedOpts): Promise<void> {
  const snapshot = await loadSnapshot(undefined, opts)

  const inputs = await resolveInputs(files)
  if (inputs === null) {
    process.exitCode = 1
    return
  }
  if (inputs.length === 0) {
    console.error(chalk.dim('  No modified files. Nothing affected.'))
    return
  }

  const result = computeAffected(snapshot, inputs, {
    includeIndirect: !!opts.includeIndirect,
    maxDepth: parseInt(opts.maxDepth ?? '0', 10) || Infinity,
  })

  // Optionnel : scan des tests à la volée si --tests-glob fourni (utile
  // quand la config codegraph exclut les tests du snapshot, ex Sentinel).
  if (opts.testsGlob) {
    await applyGlobTests(result, opts.testsGlob)
  }

  if (opts.json) {
    printAffectedJson(inputs, result)
  } else if (opts.testsOnly) {
    // Mode pipe-friendly : un fichier par ligne, sans cosmétique.
    for (const t of result.affectedTests) console.log(t)
  } else {
    printAffectedReport(inputs, result)
  }
}

/**
 * Résout les fichiers d'entrée : ceux passés, sinon fallback `git diff
 * --name-only HEAD`. Retourne `null` si le fallback git échoue (erreur).
 */
async function resolveInputs(files: string[]): Promise<string[] | null> {
  if (files.length > 0) return files
  try {
    const { execSync } = await import('node:child_process')
    const out = execSync('git diff --name-only HEAD', { encoding: 'utf-8' }).trim()
    return out.length > 0 ? out.split('\n') : []
  } catch {
    console.error(chalk.yellow('  No files passed and `git diff --name-only HEAD` failed.'))
    return null
  }
}

/** Fusionne les tests découverts par glob dans le result (dédup + tri). */
async function applyGlobTests(result: AffectedResult, testsGlob: string): Promise<void> {
  const extraTests = await scanTestsImportingAffected(testsGlob, new Set(result.affectedFiles))
  result.affectedTests = [...new Set([...result.affectedTests, ...extraTests])].sort()
  result.affectedFiles = [...new Set([...result.affectedFiles, ...extraTests])].sort()
}

function printAffectedJson(inputs: string[], result: AffectedResult): void {
  console.log(JSON.stringify({
    inputs,
    affectedFiles: result.affectedFiles,
    affectedTests: result.affectedTests,
    unknownInputs: result.unknownInputs,
    maxDepthReached: result.maxDepthReached,
  }, null, 2))
}

function printAffectedReport(inputs: string[], result: AffectedResult): void {
  console.log(chalk.bold(`\n  Affected from ${inputs.length} input(s)\n`))
  console.log(`  ${result.affectedFiles.length} file(s) impacted (${result.affectedTests.length} test(s))`)
  if (result.unknownInputs.length > 0) {
    console.log(chalk.yellow(`  ${result.unknownInputs.length} unknown input(s) (not in graph):`))
    for (const u of result.unknownInputs) console.log(`    - ${u}`)
  }
  console.log()
  console.log(chalk.bold('  Tests to run:'))
  for (const t of result.affectedTests) console.log(`    ${t}`)
  if (result.affectedTests.length === 0) {
    console.log(chalk.dim('    (none)'))
  }
  console.log()
}

// ─── Helpers : tests-glob scanner ────────────────────────────────────────

const TEST_DISCOVER_SKIP_DIRS = new Set(['node_modules', 'dist', '.git'])
const IMPORT_PATH_RE = /^\s*(?:import|export)\s+(?:[^'"]+from\s+)?['"]([^'"]+)['"]/gm

/**
 * Walk recursive avec minimatch glob filter. Skip dirs blacklist
 * (node_modules, dist, .git). Errors silencieuses (permissions, race).
 */
async function discoverTestCandidates(
  testsGlob: string,
  cwd: string,
  fastGlob: typeof import('node:fs/promises'),
  pathMod: typeof import('node:path'),
  minimatch: any,
): Promise<string[]> {
  const candidates: string[] = []
  const walk = async (dir: string): Promise<void> => {
    try {
      const entries = await fastGlob.readdir(dir, { withFileTypes: true })
      for (const e of entries) {
        const full = pathMod.join(dir, e.name)
        if (e.isDirectory()) {
          if (TEST_DISCOVER_SKIP_DIRS.has(e.name)) continue
          // await-ok: walk recursif tests-discovery — sequentiel acceptable, perf non-critique CLI affected.
          await walk(full)
        } else {
          const rel = pathMod.relative(cwd, full).replace(/\\/g, '/')
          if (minimatch(rel, testsGlob)) candidates.push(rel)
        }
      }
    } catch { /* dir unreadable (permissions, race) — skip ce sous-arbre */ }
  }
  await walk(cwd)
  return candidates
}

function extractImportPaths(content: string): Set<string> {
  const out = new Set<string>()
  IMPORT_PATH_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = IMPORT_PATH_RE.exec(content)) !== null) {
    out.add(m[1])
  }
  return out
}

/**
 * True si l'1 des candidats `<rel>.ts | <rel>.tsx | <rel>/index.ts`
 * est dans le set affected. Strip `.js` extension (ESM-style imports
 * d'un `.ts`).
 */
function importHitsAffectedFile(
  importPath: string,
  testDir: string,
  affectedFiles: Set<string>,
  pathMod: typeof import('node:path'),
): boolean {
  if (!importPath.startsWith('.')) return false
  const stripped = importPath.replace(/\.js$/, '')
  const resolvedNoExt = pathMod.normalize(pathMod.join(testDir, stripped)).replace(/\\/g, '/')
  const candidates = [
    resolvedNoExt + '.ts',
    resolvedNoExt + '.tsx',
    resolvedNoExt + '/index.ts',
  ]
  return candidates.some((c) => affectedFiles.has(c))
}

async function scanTestsImportingAffected(
  testsGlob: string,
  affectedFiles: Set<string>,
): Promise<string[]> {
  const fastGlob = await import('node:fs/promises')
  const pathMod = await import('node:path')
  const minimatchMod = await import('minimatch')
  const minimatch = (minimatchMod as any).minimatch ?? (minimatchMod as any).default
  const cwd = process.cwd()

  const candidates = await discoverTestCandidates(testsGlob, cwd, fastGlob, pathMod, minimatch)

  // Lit N test files en parallele (I/O independantes), parse sequentiel.
  const testContents = await Promise.all(
    candidates.map(async (test) => {
      try {
        return { test, content: await fastGlob.readFile(pathMod.join(cwd, test), 'utf-8') }
      } catch { return null }
    }),
  )

  const matchingTests: string[] = []
  for (const entry of testContents) {
    if (!entry) continue
    const { test, content } = entry
    const importPaths = extractImportPaths(content)
    const testDir = pathMod.dirname(test)
    for (const imp of importPaths) {
      if (importHitsAffectedFile(imp, testDir, affectedFiles, pathMod)) {
        matchingTests.push(test)
        break
      }
    }
  }
  return [...new Set(matchingTests)].sort()
}

// ─── Helpers : BFS reverse sur edges ─────────────────────────────────────

type CliEdge = { from: string; to: string; type: string }

const CLI_TEST_FILE_RE = /(\.test\.tsx?|\.spec\.tsx?|^tests?\/|\/tests?\/)/

function buildCliImporterIndex(
  edges: CliEdge[],
  opts: { includeIndirect: boolean },
): Map<string, Set<string>> {
  const importerOf = new Map<string, Set<string>>()
  for (const e of edges) {
    const isPrimary = e.type === 'import'
    const isIndirect = opts.includeIndirect && (e.type === 'event' || e.type === 'queue' || e.type === 'db-table')
    if (!isPrimary && !isIndirect) continue
    if (!importerOf.has(e.to)) importerOf.set(e.to, new Set())
    importerOf.get(e.to)!.add(e.from)
  }
  return importerOf
}

function bfsCliAffected(
  inputs: string[],
  nodeIds: Set<string>,
  importerOf: Map<string, Set<string>>,
  maxDepth: number,
): { affected: Set<string>; unknownInputs: string[]; maxDepthReached: number } {
  const affected = new Set<string>()
  const unknownInputs: string[] = []
  const queue: Array<{ file: string; depth: number }> = []
  for (const input of inputs) {
    const norm = input.replace(/\\/g, '/')
    if (!nodeIds.has(norm)) { unknownInputs.push(norm); continue }
    affected.add(norm)
    queue.push({ file: norm, depth: 0 })
  }
  let maxDepthReached = 0
  while (queue.length > 0) {
    const { file, depth } = queue.shift()!
    if (depth >= maxDepth) continue
    const importers = importerOf.get(file)
    if (!importers) continue
    for (const importer of importers) {
      if (affected.has(importer)) continue
      affected.add(importer)
      maxDepthReached = Math.max(maxDepthReached, depth + 1)
      if (depth + 1 < maxDepth) queue.push({ file: importer, depth: depth + 1 })
    }
  }
  return { affected, unknownInputs, maxDepthReached }
}

export interface AffectedSnapshot {
  nodes?: Array<{ id: string }>
  edges?: CliEdge[]
}

export interface AffectedResult {
  affectedFiles: string[]
  affectedTests: string[]
  maxDepthReached: number
  unknownInputs: string[]
}

/**
 * Cœur pur : BFS reverse depuis `files` vers tous leurs importers
 * transitifs. `includeIndirect` ajoute les edges event/queue/db-table.
 */
export function computeAffected(
  snapshot: AffectedSnapshot,
  files: string[],
  options: { includeIndirect?: boolean; maxDepth?: number },
): AffectedResult {
  const includeIndirect = options.includeIndirect ?? false
  const maxDepth = options.maxDepth ?? Infinity
  const edges: CliEdge[] = snapshot.edges ?? []
  const nodeIds = new Set<string>((snapshot.nodes ?? []).map((n) => n.id))

  const importerOf = buildCliImporterIndex(edges, { includeIndirect })
  const { affected, unknownInputs, maxDepthReached } = bfsCliAffected(files, nodeIds, importerOf, maxDepth)

  const affectedFiles = [...affected].sort()
  const affectedTests = affectedFiles.filter((f) => CLI_TEST_FILE_RE.test(f))
  return { affectedFiles, affectedTests, maxDepthReached, unknownInputs }
}
