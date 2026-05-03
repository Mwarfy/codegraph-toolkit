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

type AffectedEdge = { from: string; to: string; type: string }

interface AffectedAnalysis {
  affectedFiles: string[]
  affectedTests: string[]
  unknownInputs: string[]
  maxDepthReached: number
}

const TEST_FILE_RE = /(\.test\.tsx?|\.spec\.tsx?|^tests?\/|\/tests?\/)/

function buildImporterIndex(edges: AffectedEdge[], includeIndirect: boolean): Map<string, Set<string>> {
  const importerOf = new Map<string, Set<string>>()
  for (const e of edges) {
    const isPrimary = e.type === 'import'
    const isIndirect = includeIndirect && (e.type === 'event' || e.type === 'queue' || e.type === 'db-table')
    if (!isPrimary && !isIndirect) continue
    if (!importerOf.has(e.to)) importerOf.set(e.to, new Set())
    importerOf.get(e.to)!.add(e.from)
  }
  return importerOf
}

function bfsAffectedFromInputs(
  inputs: string[],
  nodeIds: Set<string>,
  importerOf: Map<string, Set<string>>,
  maxDepth: number,
): { affected: Set<string>; unknownInputs: string[]; maxDepthReached: number } {
  const affected = new Set<string>()
  const unknownInputs: string[] = []
  const queue: Array<{ file: string; depth: number }> = []

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
  return { affected, unknownInputs, maxDepthReached }
}

function formatAffectedReport(
  inputCount: number,
  analysis: AffectedAnalysis,
  separateTests: boolean,
): string {
  const lines: string[] = [
    `📡 Affected analysis (BFS reverse from ${inputCount} input file(s)):`,
    '',
    `  Total affected: ${analysis.affectedFiles.length} files`,
  ]
  if (separateTests) lines.push(`  Affected tests: ${analysis.affectedTests.length}`)
  lines.push(`  Max BFS depth reached: ${analysis.maxDepthReached}`)
  if (analysis.unknownInputs.length > 0) {
    lines.push(`  Unknown inputs (not in graph): ${analysis.unknownInputs.length}`)
    for (const u of analysis.unknownInputs.slice(0, 5)) lines.push(`    - ${u}`)
    if (analysis.unknownInputs.length > 5) {
      lines.push(`    +${analysis.unknownInputs.length - 5} more`)
    }
  }
  lines.push('')

  if (separateTests && analysis.affectedTests.length > 0) {
    lines.push('## Tests to run')
    for (const t of analysis.affectedTests.slice(0, 50)) lines.push(`  ${t}`)
    if (analysis.affectedTests.length > 50) {
      lines.push(`  ... +${analysis.affectedTests.length - 50} more`)
    }
    lines.push('')
  }

  lines.push('## All affected (sorted)')
  for (const f of analysis.affectedFiles.slice(0, 100)) lines.push(`  ${f}`)
  if (analysis.affectedFiles.length > 100) {
    lines.push(`  ... +${analysis.affectedFiles.length - 100} more`)
  }
  return lines.join('\n')
}

export function codegraphAffected(args: AffectedArgs): { content: string } {
  const repoRoot = args.repo_root ?? process.cwd()
  const includeIndirect = args.include_indirect ?? false
  const maxDepth = args.max_depth ?? Infinity
  const separateTests = args.separate_tests ?? true

  const inputs = args.files.map((f) =>
    path.isAbsolute(f) ? path.relative(repoRoot, f).replace(/\\/g, '/') : f.replace(/\\/g, '/'),
  )

  const snapshot = loadSnapshot(repoRoot)
  const edges: AffectedEdge[] = snapshot.edges ?? []
  const nodeIds = new Set<string>((snapshot.nodes ?? []).map((n: any) => n.id))

  const importerOf = buildImporterIndex(edges, includeIndirect)
  const { affected, unknownInputs, maxDepthReached } = bfsAffectedFromInputs(inputs, nodeIds, importerOf, maxDepth)

  const affectedFiles = [...affected].sort()
  const affectedTests = separateTests ? affectedFiles.filter((f) => TEST_FILE_RE.test(f)) : []

  return {
    content: formatAffectedReport(inputs.length, {
      affectedFiles, affectedTests, unknownInputs, maxDepthReached,
    }, separateTests),
  }
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

  const edges: AffectedEdge[] = snapshot.edges ?? []
  const nodeIds = new Set<string>((snapshot.nodes ?? []).map((n: any) => n.id))
  const importerOf = buildImporterIndex(edges, includeIndirect)
  const { affected, unknownInputs, maxDepthReached } = bfsAffectedFromInputs(files, nodeIds, importerOf, maxDepth)

  const affectedFiles = [...affected].sort()
  const affectedTests = affectedFiles.filter((f) => TEST_FILE_RE.test(f))

  return { affectedFiles, affectedTests, maxDepthReached, unknownInputs }
}
