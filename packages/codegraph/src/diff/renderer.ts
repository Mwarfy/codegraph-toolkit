/**
 * Markdown renderer pour `StructuralDiff` — phase 3 du PLAN.md.
 *
 * Rend un diff lisible en sections claires, chacune omise si vide.
 * Déterministe : même diff → octet-équivalent. Pas de prose, que des
 * bullets + fiches.
 *
 * Budget attendu : < 50 lignes sur un commit typique Sentinel. Les
 * modules de liste (signatures, call edges) sont cappés quand ils
 * explosent pour garder le rapport lisible.
 */

import type {
  StructuralDiff,
  CyclesDiff,
  TypedCallsDiff,
  StateMachinesDiff,
  TruthPointsDiff,
  DataFlowsDiff,
  CycleGatingChange,
  StateMachineChange,
  TruthPointChange,
  DataFlowChange,
  SignatureChange,
} from './types.js'
import type { TypedSignature } from '../core/types.js'

const DEFAULT_LIST_CAP = 50  // par section, avant « + N autres »

export function renderStructuralDiffMarkdown(
  diff: StructuralDiff,
  opts: { listCap?: number } = {},
): string {
  const cap = opts.listCap ?? DEFAULT_LIST_CAP
  const parts: string[] = []

  parts.push(renderHeader(diff))
  parts.push(renderSummary(diff))

  const cyclesMd = renderCyclesSection(diff.cycles)
  if (cyclesMd) parts.push(cyclesMd)

  const typedCallsMd = renderTypedCallsSection(diff.typedCalls, cap)
  if (typedCallsMd) parts.push(typedCallsMd)

  const fsmMd = renderStateMachinesSection(diff.stateMachines, cap)
  if (fsmMd) parts.push(fsmMd)

  const truthMd = renderTruthPointsSection(diff.truthPoints, cap)
  if (truthMd) parts.push(truthMd)

  const flowsMd = renderDataFlowsSection(diff.dataFlows, cap)
  if (flowsMd) parts.push(flowsMd)

  if (parts.length === 2) {
    parts.push('_Aucun changement structurel._')
  }

  return parts.join('\n\n') + '\n'
}

// ─── Header + Summary ──────────────────────────────────────────────────────

function renderHeader(diff: StructuralDiff): string {
  const from = diff.fromCommit ? `\`${diff.fromCommit.slice(0, 12)}\`` : '?'
  const to = diff.toCommit ? `\`${diff.toCommit.slice(0, 12)}\`` : '?'
  return `# Structural Diff\n\n> ${from} → ${to} · généré ${diff.generatedAt}`
}

function renderSummary(diff: StructuralDiff): string {
  const s = diff.summary
  const lines: string[] = ['## Summary', '']

  const row = (label: string, delta: string): string => `- **${label}** — ${delta}`
  const delta = (added: number, removed: number, extra?: string): string => {
    const parts: string[] = []
    if (added) parts.push(`+${added}`)
    if (removed) parts.push(`−${removed}`)
    if (parts.length === 0) parts.push('0')
    if (extra) parts.push(extra)
    return parts.join(' · ')
  }

  lines.push(row('Cycles', delta(
    s.cyclesAdded,
    s.cyclesRemoved,
    s.cyclesGatingChanged ? `${s.cyclesGatingChanged} gating change(s)` : undefined,
  )))
  lines.push(row('Signatures', delta(
    s.signaturesAdded,
    s.signaturesRemoved,
    s.signaturesModified
      ? `${s.signaturesModified} modified (${s.signaturesBreaking} breaking)`
      : undefined,
  )))
  lines.push(row('Call edges', delta(s.callEdgesAdded, s.callEdgesRemoved)))
  lines.push(row('State machines', delta(
    s.fsmsAdded,
    s.fsmsRemoved,
    s.fsmsChanged ? `${s.fsmsChanged} changed` : undefined,
  )))
  lines.push(row('Truth points', delta(
    s.truthPointsAdded,
    s.truthPointsRemoved,
    s.truthPointsChanged ? `${s.truthPointsChanged} changed` : undefined,
  )))
  lines.push(row('Data flows', delta(
    s.flowsAdded,
    s.flowsRemoved,
    s.flowsChanged ? `${s.flowsChanged} changed` : undefined,
  )))

  return lines.join('\n')
}

// ─── Cycles ─────────────────────────────────────────────────────────────────

function renderCyclesSection(d: CyclesDiff): string | null {
  if (d.added.length === 0 && d.removed.length === 0 && d.gatingChanged.length === 0) return null
  const lines: string[] = ['## Cycles', '']

  if (d.added.length > 0) {
    lines.push('### Added')
    for (const c of d.added) {
      const tag = c.gated ? '_gated_' : '**non-gated**'
      lines.push(`- ${tag} · \`${c.id}\` · ${c.nodes.join(' → ')} (SCC ${c.sccSize})`)
    }
    lines.push('')
  }
  if (d.removed.length > 0) {
    lines.push('### Removed')
    for (const c of d.removed) {
      lines.push(`- \`${c.id}\` · ${c.nodes.join(' → ')}`)
    }
    lines.push('')
  }
  if (d.gatingChanged.length > 0) {
    lines.push('### Gating changed')
    for (const g of d.gatingChanged) lines.push(renderGatingChange(g))
    lines.push('')
  }

  return lines.join('\n').trimEnd()
}

function renderGatingChange(g: CycleGatingChange): string {
  const arrow = g.nowGated ? 'non-gated → **gated**' : '**gated → non-gated**'
  return `- \`${g.cycleId}\` · ${arrow} · ${g.nodes.join(' → ')}`
}

// ─── Typed calls ────────────────────────────────────────────────────────────

function renderTypedCallsSection(d: TypedCallsDiff, cap: number): string | null {
  const hasContent =
    d.addedSignatures.length > 0 ||
    d.removedSignatures.length > 0 ||
    d.modifiedSignatures.length > 0
  if (!hasContent) return null

  const lines: string[] = ['## Typed Calls', '']

  if (d.modifiedSignatures.length > 0) {
    const breaking = d.modifiedSignatures.filter((m) => m.breaking)
    const nonBreaking = d.modifiedSignatures.filter((m) => !m.breaking)

    if (breaking.length > 0) {
      lines.push(`### Breaking (${breaking.length})`)
      appendCapped(lines, breaking, renderSignatureChange, cap)
      lines.push('')
    }
    if (nonBreaking.length > 0) {
      lines.push(`### Modified (${nonBreaking.length})`)
      appendCapped(lines, nonBreaking, renderSignatureChange, cap)
      lines.push('')
    }
  }

  if (d.addedSignatures.length > 0) {
    lines.push(`### Added (${d.addedSignatures.length})`)
    appendCapped(lines, d.addedSignatures, renderSignatureLine, cap)
    lines.push('')
  }
  if (d.removedSignatures.length > 0) {
    lines.push(`### Removed (${d.removedSignatures.length})`)
    appendCapped(lines, d.removedSignatures, renderSignatureLine, cap)
    lines.push('')
  }

  return lines.join('\n').trimEnd()
}

function renderSignatureLine(s: TypedSignature): string {
  const params = s.params.map((p) => `${p.name}${p.optional ? '?' : ''}: ${p.type}`).join(', ')
  return `- \`${s.file}:${s.exportName}(${params}): ${s.returnType}\``
}

function renderSignatureChange(m: SignatureChange): string {
  const beforeParams = m.before.params.map((p) => `${p.name}${p.optional ? '?' : ''}: ${p.type}`).join(', ')
  const afterParams = m.after.params.map((p) => `${p.name}${p.optional ? '?' : ''}: ${p.type}`).join(', ')
  const reasons = m.breaking ? ` _(${m.breakingReasons.join(', ')})_` : ''
  return `- \`${m.file}:${m.exportName}\`${reasons}\n    - before: \`(${beforeParams}): ${m.before.returnType}\`\n    - after:  \`(${afterParams}): ${m.after.returnType}\``
}

// ─── State machines ─────────────────────────────────────────────────────────

function renderStateMachinesSection(d: StateMachinesDiff, cap: number): string | null {
  if (d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0) return null
  const lines: string[] = ['## State Machines', '']

  if (d.added.length > 0) {
    lines.push(`### Added FSM (${d.added.length})`)
    for (const fsm of d.added) {
      lines.push(`- \`${fsm.concept}\` [${fsm.states.join(' | ')}] — ${fsm.transitions.length} transition(s)`)
    }
    lines.push('')
  }
  if (d.removed.length > 0) {
    lines.push(`### Removed FSM (${d.removed.length})`)
    for (const fsm of d.removed) lines.push(`- \`${fsm.concept}\``)
    lines.push('')
  }
  if (d.changed.length > 0) {
    lines.push(`### Changed FSM (${d.changed.length})`)
    for (const fsm of d.changed) lines.push(renderFsmChange(fsm, cap))
    lines.push('')
  }

  return lines.join('\n').trimEnd()
}

function renderFsmChange(f: StateMachineChange, cap: number): string {
  const lines: string[] = [`- \`${f.concept}\``]
  if (f.statesAdded.length > 0) lines.push(`    - +state: ${f.statesAdded.join(', ')}`)
  if (f.statesRemoved.length > 0) lines.push(`    - −state: ${f.statesRemoved.join(', ')}`)
  if (f.orphansAdded.length > 0) lines.push(`    - +orphan: ${f.orphansAdded.join(', ')}`)
  if (f.orphansResolved.length > 0) lines.push(`    - −orphan: ${f.orphansResolved.join(', ')}`)
  if (f.deadAdded.length > 0) lines.push(`    - +dead: ${f.deadAdded.join(', ')}`)
  if (f.deadResolved.length > 0) lines.push(`    - −dead: ${f.deadResolved.join(', ')}`)
  if (f.transitionsAdded.length > 0) {
    lines.push(`    - +transition (${f.transitionsAdded.length})`)
    const shown = f.transitionsAdded.slice(0, Math.max(0, cap))
    for (const t of shown) {
      lines.push(`        - ${t.trigger.kind}:${t.trigger.id || '-'} → ${t.to} @ ${t.file}:${t.line}`)
    }
    if (f.transitionsAdded.length > shown.length) {
      lines.push(`        - _… +${f.transitionsAdded.length - shown.length} more_`)
    }
  }
  if (f.transitionsRemoved.length > 0) {
    lines.push(`    - −transition (${f.transitionsRemoved.length})`)
    const shown = f.transitionsRemoved.slice(0, Math.max(0, cap))
    for (const t of shown) {
      lines.push(`        - ${t.trigger.kind}:${t.trigger.id || '-'} → ${t.to} @ ${t.file}:${t.line}`)
    }
    if (f.transitionsRemoved.length > shown.length) {
      lines.push(`        - _… −${f.transitionsRemoved.length - shown.length} more_`)
    }
  }
  return lines.join('\n')
}

// ─── Truth points ───────────────────────────────────────────────────────────

function renderTruthPointsSection(d: TruthPointsDiff, cap: number): string | null {
  if (d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0) return null
  const lines: string[] = ['## Truth Points', '']

  if (d.added.length > 0) {
    lines.push(`### Added (${d.added.length})`)
    for (const tp of d.added) {
      const canonical = tp.canonical ? ` canonical=${tp.canonical.name}` : ' _no canonical_'
      const mirrors = tp.mirrors.length > 0 ? ` mirrors=${tp.mirrors.length}` : ''
      lines.push(`- \`${tp.concept}\`${canonical}${mirrors}`)
    }
    lines.push('')
  }
  if (d.removed.length > 0) {
    lines.push(`### Removed (${d.removed.length})`)
    for (const tp of d.removed) lines.push(`- \`${tp.concept}\``)
    lines.push('')
  }
  if (d.changed.length > 0) {
    lines.push(`### Changed (${d.changed.length})`)
    for (const c of d.changed) lines.push(renderTruthPointChange(c, cap))
    lines.push('')
  }

  return lines.join('\n').trimEnd()
}

function renderTruthPointChange(c: TruthPointChange, cap: number): string {
  const lines: string[] = [`- \`${c.concept}\``]
  if (c.canonicalBefore !== c.canonicalAfter) {
    const before = c.canonicalBefore ?? '_none_'
    const after = c.canonicalAfter ?? '_none_'
    lines.push(`    - canonical: ${before} → ${after}`)
  }
  const lineBlock = (label: string, items: Array<{ key: string }>): void => {
    if (items.length === 0) return
    lines.push(`    - ${label} (${items.length})`)
    const shown = items.slice(0, Math.max(0, cap))
    for (const it of shown) lines.push(`        - \`${it.key}\``)
    if (items.length > shown.length) lines.push(`        - _… ${items.length - shown.length} more_`)
  }
  // Mirrors ont une clé `key`; les autres listes n'en ont pas — on renomme
  // générique vers `key` via mapping.
  lineBlock('+mirrors', c.mirrorsAdded.map((m) => ({ key: `${m.kind}:${m.key}` })))
  lineBlock('−mirrors', c.mirrorsRemoved.map((m) => ({ key: `${m.kind}:${m.key}` })))
  lineBlock('+writers', c.writersAdded.map((r) => ({ key: `${r.file}:${r.symbol}` })))
  lineBlock('−writers', c.writersRemoved.map((r) => ({ key: `${r.file}:${r.symbol}` })))
  lineBlock('+readers', c.readersAdded.map((r) => ({ key: `${r.file}:${r.symbol}` })))
  lineBlock('−readers', c.readersRemoved.map((r) => ({ key: `${r.file}:${r.symbol}` })))
  lineBlock('+exposed', c.exposedAdded.map((e) => ({ key: `${e.kind}:${e.id}` })))
  lineBlock('−exposed', c.exposedRemoved.map((e) => ({ key: `${e.kind}:${e.id}` })))
  return lines.join('\n')
}

// ─── Data flows ─────────────────────────────────────────────────────────────

function renderDataFlowsSection(d: DataFlowsDiff, cap: number): string | null {
  if (d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0) return null
  const lines: string[] = ['## Data Flows', '']

  if (d.added.length > 0) {
    lines.push(`### Added entry-points (${d.added.length})`)
    for (const e of d.added) lines.push(`- \`${e.kind}:${e.id}\` @ ${e.file}:${e.line}`)
    lines.push('')
  }
  if (d.removed.length > 0) {
    lines.push(`### Removed entry-points (${d.removed.length})`)
    for (const e of d.removed) lines.push(`- \`${e.kind}:${e.id}\``)
    lines.push('')
  }
  if (d.changed.length > 0) {
    lines.push(`### Changed flows (${d.changed.length})`)
    for (const c of d.changed) lines.push(renderDataFlowChange(c, cap))
    lines.push('')
  }

  return lines.join('\n').trimEnd()
}

function renderDataFlowChange(c: DataFlowChange, cap: number): string {
  const lines: string[] = [`- \`${c.entryKind}:${c.entryId}\``]
  if (c.stepCountBefore !== c.stepCountAfter) {
    lines.push(`    - steps: ${c.stepCountBefore} → ${c.stepCountAfter}`)
  }
  if (c.sinksAdded.length > 0) {
    lines.push(`    - +sink (${c.sinksAdded.length})`)
    const shown = c.sinksAdded.slice(0, Math.max(0, cap))
    for (const s of shown) lines.push(`        - ${s.kind}:${s.target} @ ${s.file}:${s.line}`)
    if (c.sinksAdded.length > shown.length) lines.push(`        - _… +${c.sinksAdded.length - shown.length} more_`)
  }
  if (c.sinksRemoved.length > 0) {
    lines.push(`    - −sink (${c.sinksRemoved.length})`)
    const shown = c.sinksRemoved.slice(0, Math.max(0, cap))
    for (const s of shown) lines.push(`        - ${s.kind}:${s.target} @ ${s.file}:${s.line}`)
    if (c.sinksRemoved.length > shown.length) lines.push(`        - _… −${c.sinksRemoved.length - shown.length} more_`)
  }
  return lines.join('\n')
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function appendCapped<T>(
  lines: string[],
  items: T[],
  render: (item: T) => string,
  cap: number,
): void {
  const shown = items.slice(0, Math.max(0, cap))
  for (const item of shown) lines.push(render(item))
  if (items.length > shown.length) {
    lines.push(`- _… +${items.length - shown.length} more_`)
  }
}
