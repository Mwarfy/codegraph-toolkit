/**
 * codegraph_truth_point_for(path) — détaille la participation d'un
 * fichier aux truth-points (concepts canoniques avec writers/readers/mirrors).
 *
 * Exemple : reporter.ts est reader de trust_scores, approvals, block_metrics,
 *           et writer de entities. Un changement dans reporter.ts touche
 *           potentiellement la SSOT de 4 entités métier.
 */

import { loadSnapshot, toRelPath } from '../snapshot-loader.js'

export interface TruthPointArgs {
  file_path: string
  repo_root?: string
}

export function codegraphTruthPointFor(args: TruthPointArgs): { content: string } {
  const repoRoot = args.repo_root ?? process.cwd()
  const snapshot = loadSnapshot(repoRoot)
  const relPath = toRelPath(repoRoot, args.file_path)

  const truthPoints = snapshot.truthPoints ?? []
  const participations: Array<{
    concept: string
    canonical: any
    role: string
    site: { symbol?: string; line?: number }
  }> = []

  for (const tp of truthPoints) {
    for (const w of tp.writers ?? []) {
      if (w.file === relPath) participations.push({ concept: tp.concept, canonical: tp.canonical, role: 'writer', site: w })
    }
    for (const r of tp.readers ?? []) {
      if (r.file === relPath) participations.push({ concept: tp.concept, canonical: tp.canonical, role: 'reader', site: r })
    }
    for (const m of tp.mirrors ?? []) {
      if (m.file === relPath) participations.push({ concept: tp.concept, canonical: tp.canonical, role: 'mirror', site: m })
    }
  }

  if (participations.length === 0) {
    return { content: `${relPath} does not participate in any truth-point.` }
  }

  // Group by concept
  const byConcept = new Map<string, typeof participations>()
  for (const p of participations) {
    if (!byConcept.has(p.concept)) byConcept.set(p.concept, [])
    byConcept.get(p.concept)!.push(p)
  }

  const lines: string[] = []
  lines.push(`📊 ${relPath} participates in ${byConcept.size} truth-point(s):`)

  for (const [concept, parts] of byConcept) {
    const canonical = parts[0].canonical
    lines.push(`\n## ${concept} (canonical: ${canonical?.kind ?? '?'} ${canonical?.name ?? ''})`)
    for (const p of parts) {
      const sym = p.site.symbol ?? '(no symbol)'
      const line = p.site.line ? `:${p.site.line}` : ''
      lines.push(`  ${p.role.padEnd(7)} ${sym}${line}`)
    }
  }

  lines.push('\n💡 Modifying this file affects the schema-of-truth for these concepts.')
  lines.push('   Check downstream consumers (other readers/mirrors) before changing writes.')

  return { content: lines.join('\n') }
}
