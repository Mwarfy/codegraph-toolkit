/**
 * `codegraph discover` — observe les sessions Claude Code passées pour
 * identifier où l'injection contextuelle (synopsis, ADR hooks) a probablement
 * raté. Inspiré de `rtk discover` (qui mesure où RTK serait utile dans les
 * sessions), adapté à la cible "ratés de contexte structurel".
 *
 * Public API : `readSessions`, `classify`, `formatReport`.
 */

export {
  encodeProjectPath,
  sessionsDir,
  readSessions,
  type ToolUse,
  type SessionsReadResult,
  type ToolName,
} from './session-reader.js'

export { classify, type DiscoverReport, type DiscoverReportRow } from './classifier.js'

import type { DiscoverReport } from './classifier.js'

/**
 * Format a markdown report for human consumption. JSON output is consumed
 * directly via `JSON.stringify(report)`.
 */
export function formatReport(report: DiscoverReport): string {
  const out: string[] = []
  out.push('# CodeGraph Discover Report')
  out.push('')
  out.push('## Totals')
  out.push('')
  out.push(`- Sessions analysées : **${report.totals.sessions}**`)
  out.push(`- Tool uses : **${report.totals.toolUses}** (${report.totals.reads} Read · ${report.totals.edits} Edit · ${report.totals.greps} Grep · ${report.totals.bashCalls} Bash)`)
  out.push('')

  if (report.hubReads.length > 0) {
    out.push('## Hub reads — fichiers load-bearing lus malgré le synopsis')
    out.push('')
    out.push('Signal : le LLM a Read un top hub (in-degree élevé). Suggère que le synopsis ou le hook d\'injection contextuelle ne suffit pas — le hub aurait dû être assez "présent" dans le contexte pour éviter une lecture exploratoire.')
    out.push('')
    out.push('| Hub | Reads | Edits | Sessions | in-deg | rank |')
    out.push('|---|---:|---:|---:|---:|---:|')
    for (const r of report.hubReads) {
      out.push(`| \`${r.file}\` | ${r.reads} | ${r.edits} | ${r.sessions} | ${r.inDegree ?? '–'} | #${r.hubRank ?? '–'} |`)
    }
    out.push('')
  }

  if (report.repeatReads.length > 0) {
    out.push('## Repeat reads — même fichier lu ≥3× dans la même session')
    out.push('')
    out.push('Signal : context manqué côté LLM ou hook qui ne propage pas. La 2e/3e Read aurait pu être économisée si le contenu du fichier était resté dans le contexte ou ré-injecté par le hook.')
    out.push('')
    out.push('| Session | File | Reads |')
    out.push('|---|---|---:|')
    for (const r of report.repeatReads) {
      out.push(`| \`${r.sessionId.slice(0, 8)}\` | \`${r.file}\` | ${r.reads} |`)
    }
    out.push('')
  }

  if (report.grepOnHubSymbols.length > 0) {
    out.push('## Grep-on-hub-symbol — recherches qui auraient pu être évitées')
    out.push('')
    out.push('Signal : le LLM a fait un Grep dont le pattern matche le nom d\'un fichier hub. Le synopsis aurait pu pointer ce fichier directement.')
    out.push('')
    out.push('| Pattern | Hub matché | Occurrences |')
    out.push('|---|---|---:|')
    for (const r of report.grepOnHubSymbols) {
      out.push(`| \`${r.pattern}\` | \`${r.matchedHubFile}\` | ${r.count} |`)
    }
    out.push('')
  }

  if (report.hubReads.length === 0 && report.repeatReads.length === 0 && report.grepOnHubSymbols.length === 0) {
    out.push('## Aucun raté détecté sur les axes mesurés')
    out.push('')
    out.push('Soit ton injection contextuelle marche bien, soit les sessions analysées sont trop peu nombreuses pour conclure. Augmenter `--since-days` pour élargir la fenêtre.')
    out.push('')
  }

  return out.join('\n')
}
