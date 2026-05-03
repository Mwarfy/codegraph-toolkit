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

interface ParticipationSite { symbol?: string; line?: number }
interface Participation {
  concept: string
  canonical: any
  role: 'writer' | 'reader' | 'mirror'
  site: ParticipationSite
}

export function codegraphTruthPointFor(args: TruthPointArgs): { content: string } {
  const repoRoot = args.repo_root ?? process.cwd()
  const snapshot = loadSnapshot(repoRoot)
  const relPath = toRelPath(repoRoot, args.file_path)

  const participations = collectParticipations(snapshot.truthPoints ?? [], relPath)
  if (participations.length === 0) {
    return { content: `${relPath} does not participate in any truth-point.` }
  }
  return { content: formatParticipations(relPath, participations) }
}

/** Pour chaque truthPoint, scanne writers/readers/mirrors et match relPath. */
function collectParticipations(
  truthPoints: ReadonlyArray<any>,
  relPath: string,
): Participation[] {
  const out: Participation[] = []
  for (const tp of truthPoints) {
    pushSitesByRole(tp, 'writer', tp.writers, relPath, out)
    pushSitesByRole(tp, 'reader', tp.readers, relPath, out)
    pushSitesByRole(tp, 'mirror', tp.mirrors, relPath, out)
  }
  return out
}

function pushSitesByRole(
  tp: any,
  role: Participation['role'],
  sites: ReadonlyArray<{ file: string } & ParticipationSite> | undefined,
  relPath: string,
  out: Participation[],
): void {
  for (const s of sites ?? []) {
    if (s.file === relPath) {
      out.push({ concept: tp.concept, canonical: tp.canonical, role, site: s })
    }
  }
}

function formatParticipations(relPath: string, participations: Participation[]): string {
  const byConcept = groupByConcept(participations)
  const lines: string[] = []
  lines.push(`📊 ${relPath} participates in ${byConcept.size} truth-point(s):`)
  for (const [concept, parts] of byConcept) {
    appendConceptSection(concept, parts, lines)
  }
  lines.push('\n💡 Modifying this file affects the schema-of-truth for these concepts.')
  lines.push('   Check downstream consumers (other readers/mirrors) before changing writes.')
  return lines.join('\n')
}

function groupByConcept(participations: Participation[]): Map<string, Participation[]> {
  const byConcept = new Map<string, Participation[]>()
  for (const p of participations) {
    if (!byConcept.has(p.concept)) byConcept.set(p.concept, [])
    byConcept.get(p.concept)!.push(p)
  }
  return byConcept
}

function appendConceptSection(
  concept: string,
  parts: Participation[],
  lines: string[],
): void {
  const canonical = parts[0].canonical
  lines.push(`\n## ${concept} (canonical: ${canonical?.kind ?? '?'} ${canonical?.name ?? ''})`)
  for (const p of parts) {
    const sym = p.site.symbol ?? '(no symbol)'
    const line = p.site.line ? `:${p.site.line}` : ''
    lines.push(`  ${p.role.padEnd(7)} ${sym}${line}`)
  }
}
