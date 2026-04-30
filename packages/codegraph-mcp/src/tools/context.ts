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

export function codegraphContext(args: ContextArgs): { content: string } {
  const repoRoot = args.repo_root ?? process.cwd()
  const snapshot = loadSnapshot(repoRoot)
  const relPath = toRelPath(repoRoot, args.file_path)

  const node = snapshot.nodes?.find((n: any) => n.id === relPath)
  if (!node) {
    return { content: `File not in codegraph snapshot: ${relPath}\n(Either out of scope, or the snapshot is stale — run \`npx codegraph analyze\`.)` }
  }

  const edges = snapshot.edges ?? []
  const importers = edges.filter((e: any) => e.to === relPath && e.type === 'import')
  const imports = edges.filter((e: any) => e.from === relPath && e.type === 'import')
  const exports = node.exports ?? []
  const problematic = exports.filter((e: any) =>
    e.confidence && e.confidence !== 'used' && e.confidence !== 'test-only',
  )

  const cycles = (snapshot.cycles ?? []).filter((c: any) =>
    (c.nodes ?? c.files ?? []).includes(relPath),
  )

  const truthPointParticipations: Array<{ concept: string; role: string }> = []
  for (const tp of snapshot.truthPoints ?? []) {
    if ((tp.writers ?? []).some((w: any) => w.file === relPath)) {
      truthPointParticipations.push({ concept: tp.concept, role: 'writer' })
    }
    if ((tp.readers ?? []).some((r: any) => r.file === relPath)) {
      truthPointParticipations.push({ concept: tp.concept, role: 'reader' })
    }
    if ((tp.mirrors ?? []).some((m: any) => m.file === relPath)) {
      truthPointParticipations.push({ concept: tp.concept, role: 'mirror' })
    }
  }

  const isHub = importers.length >= 20
  const isWriter = truthPointParticipations.some(p => p.role === 'writer')

  const lines: string[] = []
  lines.push(`📍 codegraph context : ${relPath}`)

  // RISK header
  let riskScore = 0
  if (isHub) riskScore += 4
  if (isWriter) riskScore += 3
  if (cycles.length > 0) riskScore += 3
  if (riskScore >= 3) {
    const flags: string[] = []
    if (isHub) flags.push(`hub (in:${importers.length})`)
    if (isWriter) flags.push('truth-point writer')
    if (cycles.length > 0) flags.push(`${cycles.length} cycle(s)`)
    lines.push(`⚠⚠ HIGH-RISK : ${flags.join(', ')} — modifs ont un blast radius`)
  }

  lines.push(`in: ${importers.length}  out: ${imports.length}  loc: ${node.loc ?? '?'}`)

  if (importers.length > 0 && importers.length <= 30) {
    const topImporters = importers.slice(0, 5).map((e: any) => e.from)
    lines.push(`importers (${Math.min(5, importers.length)}/${importers.length}): ${topImporters.join(', ')}`)
  } else if (importers.length > 30) {
    lines.push(`importers: ${importers.length} files (top hub)`)
  }

  if (truthPointParticipations.length > 0) {
    const byConcept = new Map<string, Set<string>>()
    for (const p of truthPointParticipations) {
      if (!byConcept.has(p.concept)) byConcept.set(p.concept, new Set())
      byConcept.get(p.concept)!.add(p.role)
    }
    lines.push('📊 truth-points: ' + [...byConcept.entries()]
      .map(([c, roles]) => `${c} (${[...roles].join('/')})`)
      .join(', '))
  }

  if (cycles.length > 0) {
    for (const c of cycles.slice(0, 3)) {
      const nodesStr = (c.nodes ?? c.files ?? []).join(' → ')
      lines.push(`⚠ cycle: ${nodesStr}`)
    }
  }

  if (problematic.length > 0) {
    lines.push(`exports problématiques: ${problematic.length} (sur ${exports.length} total)`)
    for (const ex of problematic.slice(0, 5)) {
      lines.push(`  L${ex.line} ${ex.name} [${ex.confidence}]`)
    }
  }

  const longFns = (snapshot.longFunctions ?? []).filter((f: any) => f.file === relPath)
  if (longFns.length > 0) {
    lines.push(`long functions: ${longFns.length}`)
    for (const f of longFns.slice(0, 3)) {
      lines.push(`  L${f.line} ${f.name} (${f.loc} LOC)`)
    }
  }

  const magic = (snapshot.magicNumbers ?? []).filter((m: any) => m.file === relPath)
  if (magic.length >= 5) {
    lines.push(`magic numbers: ${magic.length} hardcoded`)
  }

  if (snapshot.testCoverage) {
    const entry = snapshot.testCoverage.entries.find((e: any) => e.sourceFile === relPath)
    if (entry && entry.testFiles.length === 0) {
      lines.push('🧪 no test associated')
    } else if (entry && entry.testFiles.length > 0) {
      lines.push(`🧪 ${entry.testFiles.length} test(s)`)
    }
  }

  return { content: lines.join('\n') }
}
