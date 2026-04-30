/**
 * codegraph_affected(files) — BFS reverse depuis les fichiers modifiés
 * pour trouver TOUT ce qui est impacté transitivement.
 *
 * Source : snapshot.edges (filtré sur type='import' par défaut, optionnel
 * d'inclure event/queue/db-table). Utilise un index inverse `importerOf`
 * construit en O(E) puis BFS en O(V + E).
 *
 * Use-case principal : pre-commit selector de tests. `git diff --name-only`
 * → affected files → filtre les `*.test.ts` → run uniquement ceux-là.
 * Sentinel passe de 656 tests / 5s à ~30 tests / 1s sur les modifs typiques.
 *
 * Cf. axe B1 du plan d'enrichissement.
 */

import * as path from 'node:path'
import { loadSnapshot } from '../snapshot-loader.js'

export interface AffectedArgs {
  /** Files modifiés (relatifs au repo root). Accepte path absolu aussi. */
  files: string[]
  repo_root?: string
  /** Inclure event/queue/db-table edges en plus des imports ? Default false. */
  include_indirect?: boolean
  /**
   * Profondeur max du BFS. Default Infinity (pas de cap). Mettre 1 pour
   * voir uniquement les importeurs directs.
   */
  max_depth?: number
  /**
   * Si true, retourne séparément la liste des fichiers tests parmi les
   * affected. Match les patterns `*.test.ts`, `*.spec.ts`, `tests/`.
   * Default true.
   */
  separate_tests?: boolean
}

export interface AffectedResult {
  /** Tous les fichiers impactés (incluant les inputs si présents dans le graph). */
  affectedFiles: string[]
  /** Sous-ensemble : fichiers tests parmi affectedFiles. Vide si separate_tests=false. */
  affectedTests: string[]
  /** Profondeur max atteinte dans le BFS. */
  maxDepthReached: number
  /** Inputs qui n'ont PAS été trouvés dans le graph (probablement nouveaux ou hors-scope). */
  unknownInputs: string[]
}

export function codegraphAffected(args: AffectedArgs): { content: string } {
  const repoRoot = args.repo_root ?? process.cwd()
  const includeIndirect = args.include_indirect ?? false
  const maxDepth = args.max_depth ?? Infinity
  const separateTests = args.separate_tests ?? true

  // Normalize input file paths to relative-to-repo
  const inputs = args.files.map((f) =>
    path.isAbsolute(f) ? path.relative(repoRoot, f).replace(/\\/g, '/') : f.replace(/\\/g, '/'),
  )

  const snapshot = loadSnapshot(repoRoot)
  type Edge = { from: string; to: string; type: string }
  const edges: Edge[] = snapshot.edges ?? []
  const nodeIds = new Set<string>((snapshot.nodes ?? []).map((n: any) => n.id))

  // Build reverse index : for each file F, which files import F ?
  const importerOf = new Map<string, Set<string>>()
  for (const e of edges) {
    if (e.type !== 'import' && !(includeIndirect && (e.type === 'event' || e.type === 'queue' || e.type === 'db-table'))) {
      continue
    }
    if (!importerOf.has(e.to)) importerOf.set(e.to, new Set())
    importerOf.get(e.to)!.add(e.from)
  }

  // BFS reverse from each input
  const affected = new Set<string>()
  const unknownInputs: string[] = []
  let queue: Array<{ file: string; depth: number }> = []
  for (const input of inputs) {
    if (!nodeIds.has(input)) {
      unknownInputs.push(input)
      continue
    }
    affected.add(input)
    queue.push({ file: input, depth: 0 })
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

  const affectedFiles = [...affected].sort()
  const testRe = /(\.test\.tsx?|\.spec\.tsx?|^tests?\/|\/tests?\/)/
  const affectedTests = separateTests
    ? affectedFiles.filter((f) => testRe.test(f))
    : []

  // Format output
  const lines: string[] = []
  lines.push(`📡 Affected analysis (BFS reverse from ${inputs.length} input file(s)):`)
  lines.push('')
  lines.push(`  Total affected: ${affectedFiles.length} files`)
  if (separateTests) {
    lines.push(`  Affected tests: ${affectedTests.length}`)
  }
  lines.push(`  Max BFS depth reached: ${maxDepthReached}`)
  if (unknownInputs.length > 0) {
    lines.push(`  Unknown inputs (not in graph): ${unknownInputs.length}`)
    for (const u of unknownInputs.slice(0, 5)) lines.push(`    - ${u}`)
    if (unknownInputs.length > 5) lines.push(`    +${unknownInputs.length - 5} more`)
  }
  lines.push('')

  if (separateTests && affectedTests.length > 0) {
    lines.push('## Tests to run')
    for (const t of affectedTests.slice(0, 50)) lines.push(`  ${t}`)
    if (affectedTests.length > 50) lines.push(`  ... +${affectedTests.length - 50} more`)
    lines.push('')
  }

  lines.push('## All affected (sorted)')
  for (const f of affectedFiles.slice(0, 100)) lines.push(`  ${f}`)
  if (affectedFiles.length > 100) lines.push(`  ... +${affectedFiles.length - 100} more`)

  return { content: lines.join('\n') }
}

/**
 * Variante programmatique (returns the result object, not the formatted
 * string). Utilisée par le CLI `codegraph affected-tests` qui veut juste
 * la liste machine-readable.
 */
export function computeAffected(
  snapshot: any,
  files: string[],
  options: { includeIndirect?: boolean; maxDepth?: number } = {},
): AffectedResult {
  const includeIndirect = options.includeIndirect ?? false
  const maxDepth = options.maxDepth ?? Infinity

  const edges: Array<{ from: string; to: string; type: string }> = snapshot.edges ?? []
  const nodeIds = new Set<string>((snapshot.nodes ?? []).map((n: any) => n.id))

  const importerOf = new Map<string, Set<string>>()
  for (const e of edges) {
    if (e.type !== 'import' && !(includeIndirect && (e.type === 'event' || e.type === 'queue' || e.type === 'db-table'))) {
      continue
    }
    if (!importerOf.has(e.to)) importerOf.set(e.to, new Set())
    importerOf.get(e.to)!.add(e.from)
  }

  const affected = new Set<string>()
  const unknownInputs: string[] = []
  const queue: Array<{ file: string; depth: number }> = []
  for (const input of files) {
    if (!nodeIds.has(input)) { unknownInputs.push(input); continue }
    affected.add(input)
    queue.push({ file: input, depth: 0 })
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

  const affectedFiles = [...affected].sort()
  const testRe = /(\.test\.tsx?|\.spec\.tsx?|^tests?\/|\/tests?\/)/
  const affectedTests = affectedFiles.filter((f) => testRe.test(f))

  return { affectedFiles, affectedTests, maxDepthReached, unknownInputs }
}
