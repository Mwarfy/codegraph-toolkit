/**
 * codegraph_context(path) — équivalent du bloc PostToolUse hook,
 * accessible on-demand. Permet de pull le contexte structurel d'un
 * fichier sans avoir à l'éditer.
 */

import { loadSnapshot, toRelPath } from '../snapshot-loader.js'

export interface ContextArgs {
  /** Path absolu OU relatif au rootDir. */
  file_path: string
  /** Repo root (default = cwd du serveur MCP). */
  repo_root?: string
}

interface TruthPointPart { concept: string; role: 'writer' | 'reader' | 'mirror' }

function collectTruthPointParticipations(
  truthPoints: any[],
  relPath: string,
): TruthPointPart[] {
  const out: TruthPointPart[] = []
  for (const tp of truthPoints) {
    if ((tp.writers ?? []).some((w: any) => w.file === relPath)) {
      out.push({ concept: tp.concept, role: 'writer' })
    }
    if ((tp.readers ?? []).some((r: any) => r.file === relPath)) {
      out.push({ concept: tp.concept, role: 'reader' })
    }
    if ((tp.mirrors ?? []).some((m: any) => m.file === relPath)) {
      out.push({ concept: tp.concept, role: 'mirror' })
    }
  }
  return out
}

interface RiskFlags { isHub: boolean; isWriter: boolean; cycles: any[] }

function appendRiskHeader(lines: string[], flags: RiskFlags, importerCount: number): void {
  let riskScore = 0
  if (flags.isHub) riskScore += 4
  if (flags.isWriter) riskScore += 3
  if (flags.cycles.length > 0) riskScore += 3
  if (riskScore < 3) return
  const tags: string[] = []
  if (flags.isHub) tags.push(`hub (in:${importerCount})`)
  if (flags.isWriter) tags.push('truth-point writer')
  if (flags.cycles.length > 0) tags.push(`${flags.cycles.length} cycle(s)`)
  lines.push(`⚠⚠ HIGH-RISK : ${tags.join(', ')} — modifs ont un blast radius`)
}

function appendImporters(lines: string[], importers: any[]): void {
  if (importers.length === 0) return
  if (importers.length <= 30) {
    const topImporters = importers.slice(0, 5).map((e: any) => e.from)
    lines.push(`importers (${Math.min(5, importers.length)}/${importers.length}): ${topImporters.join(', ')}`)
  } else {
    lines.push(`importers: ${importers.length} files (top hub)`)
  }
}

function appendTruthPointsLine(lines: string[], parts: TruthPointPart[]): void {
  if (parts.length === 0) return
  const byConcept = new Map<string, Set<string>>()
  for (const p of parts) {
    if (!byConcept.has(p.concept)) byConcept.set(p.concept, new Set())
    byConcept.get(p.concept)!.add(p.role)
  }
  lines.push('📊 truth-points: ' + [...byConcept.entries()]
    .map(([c, roles]) => `${c} (${[...roles].join('/')})`)
    .join(', '))
}

function appendCycles(lines: string[], cycles: any[]): void {
  if (cycles.length === 0) return
  for (const c of cycles.slice(0, 3)) {
    const nodesStr = (c.nodes ?? c.files ?? []).join(' → ')
    lines.push(`⚠ cycle: ${nodesStr}`)
  }
}

function appendProblematicExports(lines: string[], problematic: any[], totalExports: number): void {
  if (problematic.length === 0) return
  lines.push(`exports problématiques: ${problematic.length} (sur ${totalExports} total)`)
  for (const ex of problematic.slice(0, 5)) {
    lines.push(`  L${ex.line} ${ex.name} [${ex.confidence}]`)
  }
}

function appendLongFunctions(lines: string[], longFns: any[]): void {
  if (longFns.length === 0) return
  lines.push(`long functions: ${longFns.length}`)
  for (const f of longFns.slice(0, 3)) {
    lines.push(`  L${f.line} ${f.name} (${f.loc} LOC)`)
  }
}

function appendTestCoverage(lines: string[], snapshot: any, relPath: string): void {
  if (!snapshot.testCoverage) return
  const entry = snapshot.testCoverage.entries.find((e: any) => e.sourceFile === relPath)
  if (!entry) return
  if (entry.testFiles.length === 0) lines.push('🧪 no test associated')
  else lines.push(`🧪 ${entry.testFiles.length} test(s)`)
}

interface ContextDigest {
  node: any
  importers: any[]
  imports: any[]
  exports: any[]
  problematic: any[]
  cycles: any[]
  truthPointParticipations: TruthPointPart[]
  longFns: any[]
  magic: any[]
}

function digestSnapshot(snapshot: any, node: any, relPath: string): ContextDigest {
  const edges = snapshot.edges ?? []
  const importers = edges.filter((e: any) => e.to === relPath && e.type === 'import')
  const imports = edges.filter((e: any) => e.from === relPath && e.type === 'import')
  const exports = node.exports ?? []
  const problematic = exports.filter((e: any) => isProblematicExport(e))
  const cycles = (snapshot.cycles ?? []).filter((c: any) =>
    (c.nodes ?? c.files ?? []).includes(relPath),
  )
  const truthPointParticipations = collectTruthPointParticipations(snapshot.truthPoints ?? [], relPath)
  const longFns = (snapshot.longFunctions ?? []).filter((f: any) => f.file === relPath)
  const magic = (snapshot.magicNumbers ?? []).filter((m: any) => m.file === relPath)
  return { node, importers, imports, exports, problematic, cycles, truthPointParticipations, longFns, magic }
}

function isProblematicExport(e: any): boolean {
  if (!e.confidence) return false
  return e.confidence !== 'used' && e.confidence !== 'test-only'
}

export function codegraphContext(args: ContextArgs): { content: string } {
  const repoRoot = args.repo_root ?? process.cwd()
  const snapshot = loadSnapshot(repoRoot)
  const relPath = toRelPath(repoRoot, args.file_path)

  const node = snapshot.nodes?.find((n: any) => n.id === relPath)
  if (!node) {
    return { content: `File not in codegraph snapshot: ${relPath}\n(Either out of scope, or the snapshot is stale — run \`npx codegraph analyze\`.)` }
  }

  const d = digestSnapshot(snapshot, node, relPath)
  const isHub = d.importers.length >= 20
  const isWriter = d.truthPointParticipations.some(p => p.role === 'writer')

  const lines: string[] = [`📍 codegraph context : ${relPath}`]
  appendRiskHeader(lines, { isHub, isWriter, cycles: d.cycles }, d.importers.length)
  lines.push(`in: ${d.importers.length}  out: ${d.imports.length}  loc: ${node.loc ?? '?'}`)
  appendImporters(lines, d.importers)
  appendTruthPointsLine(lines, d.truthPointParticipations)
  appendCycles(lines, d.cycles)
  appendProblematicExports(lines, d.problematic, d.exports.length)
  appendLongFunctions(lines, d.longFns)
  if (d.magic.length >= 5) {
    lines.push(`magic numbers: ${d.magic.length} hardcoded`)
  }
  appendTestCoverage(lines, snapshot, relPath)

  return { content: lines.join('\n') }
}
