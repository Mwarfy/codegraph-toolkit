/**
 * Structural Map Builder — phase 1.7
 *
 * Fonction pure `GraphSnapshot → markdown`. Agrège les 5 extracteurs de
 * phase 1 (typedCalls, cycles, truthPoints, dataFlows, stateMachines) en
 * un document unique, dense, déterministe.
 *
 * Cible d'usage : un agent LLM charge MAP.md et a la forme complète du
 * projet — signatures typées, cycles, points de vérité, flows
 * bout-en-bout, FSM — sans ouvrir les fichiers source.
 *
 * Invariants :
 *   - Déterministe (tri stable partout). Même snapshot → octet-équivalent.
 *   - Pas de prose. Fiches structurées.
 *   - Budget cible Sentinel : ≤ 30k tokens.
 *   - Dégradation gracieuse : si un extracteur est absent du snapshot, sa
 *     section est omise (pas d'erreur).
 */

import type {
  GraphSnapshot,
  GraphEdge,
  TypedSignature,
  TypedCallEdge,
  Cycle,
  TruthPoint,
  DataFlow,
  DataFlowEntryKind,
  StateMachine,
} from '../core/types.js'
import { renderDsm } from './dsm-renderer.js'

export interface MapBuilderOptions {
  /** Seuil min d'in-degree pour qu'un fichier ait sa fiche en section 5. Default 2. */
  minIndegree?: number
  /** Cap total de fiches en section 5. Default 200 (sécurité budget tokens). */
  maxModulesInFiches?: number
  /** Nombre max de core flows en section 1. Default 10. */
  topCoreFlows?: number
  /** Nombre max de signatures par fichier dans la fiche. Default 8. */
  signaturesPerFile?: number
  /** Nombre max de call edges sortants par fichier. Default 8. */
  callEdgesPerFile?: number
  /**
   * Concerns : regroupement de fichiers par préoccupation (section 0.5).
   * Mapping nom humain → liste de préfixes de chemins (startsWith, pas glob).
   * Undefined ou vide → section omise.
   */
  concerns?: Record<string, string[]>
  /** Nombre max de chaînes d'events à afficher en section 2.5. Default 12. */
  maxEventFlows?: number
}

export function buildMap(snapshot: GraphSnapshot, options: MapBuilderOptions = {}): string {
  const opts: Required<Omit<MapBuilderOptions, 'concerns'>> & { concerns: Record<string, string[]> } = {
    minIndegree: options.minIndegree ?? 2,
    maxModulesInFiches: options.maxModulesInFiches ?? 200,
    topCoreFlows: options.topCoreFlows ?? 10,
    signaturesPerFile: options.signaturesPerFile ?? 8,
    callEdgesPerFile: options.callEdgesPerFile ?? 8,
    concerns: options.concerns ?? {},
    maxEventFlows: options.maxEventFlows ?? 12,
  }

  const parts: string[] = []
  parts.push(renderHeader(snapshot))
  parts.push(renderStats(snapshot))
  parts.push(renderConcernsIndex(snapshot, opts.concerns))
  parts.push(renderCoreFlows(snapshot, opts))
  parts.push(renderStateMachines(snapshot))
  parts.push(renderEventFlows(snapshot, opts.maxEventFlows))
  parts.push(renderTruthPoints(snapshot))
  parts.push(renderCycles(snapshot))
  parts.push(renderComponentMetrics(snapshot))
  parts.push(renderEnvUsage(snapshot))
  parts.push(renderPackageDeps(snapshot))
  parts.push(renderBarrels(snapshot))
  parts.push(renderTaintViolations(snapshot))
  parts.push(renderDsmSection(snapshot))
  parts.push(renderModules(snapshot, opts))
  parts.push(renderIndex(snapshot))
  return parts.filter(Boolean).join('\n\n') + '\n'
}

// ─── Section 0.5 : Concerns index ───────────────────────────────────────────

function renderConcernsIndex(
  s: GraphSnapshot,
  concerns: Record<string, string[]>,
): string {
  const names = Object.keys(concerns)
  if (names.length === 0) return ''

  const lines: string[] = ['## 0.5. Concerns', '']
  lines.push(
    '_Regroupement par préoccupation fonctionnelle. ' +
    'Pour démarrer une tâche sur un concern, lire d\'abord cette section pour cibler les fichiers à toucher._',
    '',
  )

  const allFiles = s.nodes
    .map(n => n.id)
    .filter(f => /\.(ts|tsx|js|jsx)$/.test(f))                        // exclude directory-type nodes
    .sort()
  let totalCovered = 0

  for (const name of names) {
    const prefixes = concerns[name]
    const matched = allFiles.filter(f => prefixes.some(p => f.includes(p)))
    if (matched.length === 0) continue
    totalCovered += matched.length
    lines.push(`### ${name} (${matched.length} fichiers)`)
    lines.push('')
    for (const f of matched) {
      lines.push(`- \`${f}\``)
    }
    lines.push('')
  }

  lines.push(`_Coverage : ${totalCovered}/${allFiles.length} fichiers assignés à un concern._`)
  return lines.join('\n')
}

// ─── Section 2.5 : Event flow narratives ────────────────────────────────────

interface EventChain { events: string[]; files: string[]; score: number }
interface EventCtx {
  byEvent: Map<string, { emitters: Set<string>; listeners: Set<string> }>
  fileEmits: Map<string, Set<string>>
}

function buildEventCtx(eventEdges: GraphEdge[]): EventCtx {
  const byEvent = new Map<string, { emitters: Set<string>; listeners: Set<string> }>()
  for (const e of eventEdges) {
    const name = e.label!
    if (!byEvent.has(name)) byEvent.set(name, { emitters: new Set(), listeners: new Set() })
    const entry = byEvent.get(name)!
    entry.emitters.add(e.from)
    entry.listeners.add(e.to)
  }
  const fileEmits = new Map<string, Set<string>>()
  for (const [name, ev] of byEvent) {
    for (const emitter of ev.emitters) {
      if (!fileEmits.has(emitter)) fileEmits.set(emitter, new Set())
      fileEmits.get(emitter)!.add(name)
    }
  }
  return { byEvent, fileEmits }
}

function tracePathFromEmitter(
  startEvent: string,
  emitter: string,
  ctx: EventCtx,
): EventChain | null {
  const { byEvent, fileEmits } = ctx
  const seen = new Set<string>([emitter])
  const pathFiles: string[] = [emitter]
  const pathEvents: string[] = [startEvent]
  let current = startEvent
  let depth = 0
  while (depth < 3) {
    const ev = byEvent.get(current)
    if (!ev) break
    let nextFile: string | null = null
    let nextEvent: string | null = null
    for (const listener of ev.listeners) {
      if (seen.has(listener)) continue
      const emitted = fileEmits.get(listener)
      if (!emitted) continue
      for (const cand of emitted) {
        if (!pathEvents.includes(cand)) { nextFile = listener; nextEvent = cand; break }
      }
      if (nextFile) break
    }
    if (!nextFile || !nextEvent) break
    seen.add(nextFile)
    pathFiles.push(nextFile)
    pathEvents.push(nextEvent)
    current = nextEvent
    depth++
  }
  if (pathEvents.length < 2) return null
  return { events: pathEvents, files: pathFiles, score: pathEvents.length }
}

function traceAllChains(ctx: EventCtx): EventChain[] {
  const chains: EventChain[] = []
  for (const [startEvent, startEv] of ctx.byEvent) {
    for (const emitter of startEv.emitters) {
      const chain = tracePathFromEmitter(startEvent, emitter, ctx)
      if (chain) chains.push(chain)
    }
  }
  return chains
}

function dedupAndRankChains(chains: EventChain[], maxFlows: number): {
  top: EventChain[]
  totalUnique: number
} {
  const seen = new Set<string>()
  const uniqueChains = chains.filter(c => {
    const key = c.events.join('|')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  uniqueChains.sort((a, b) => b.score - a.score || a.events[0].localeCompare(b.events[0]))
  return { top: uniqueChains.slice(0, maxFlows), totalUnique: uniqueChains.length }
}

function formatChainArrow(chain: EventChain): string {
  return chain.events.map((ev, i) => {
    const file = chain.files[i]
    const shortFile = file.split('/').slice(-2).join('/').replace(/\.ts$/, '')
    return `\`${ev}\` _(${shortFile})_`
  }).join(' → ')
}

function renderEventFlows(s: GraphSnapshot, maxFlows: number): string {
  const eventEdges = s.edges.filter(e => e.type === 'event' && e.label)
  if (eventEdges.length === 0) return ''

  const ctx = buildEventCtx(eventEdges)
  const chains = traceAllChains(ctx)
  const { top, totalUnique } = dedupAndRankChains(chains, maxFlows)

  const lines: string[] = ['## 2.5. Event flow chains', '']
  lines.push(
    '_Cascades `emit → listen → emit`. Aide à tracer un flow de bout en bout ' +
    'sans grep. Chaque fichier intermédiaire est listener de l\'event précédent ET emitter du suivant._',
    '',
  )

  if (top.length === 0) {
    lines.push('_Aucune chaîne multi-hop détectée._')
    return lines.join('\n')
  }

  for (const chain of top) {
    lines.push(`- ${formatChainArrow(chain)}`)
  }

  lines.push('')
  lines.push(`_Total : ${totalUnique} chaînes uniques détectées, top ${top.length} affichées._`)
  return lines.join('\n')
}

// ─── Section 0 : Header + Stats ─────────────────────────────────────────────

function renderHeader(s: GraphSnapshot): string {
  const lines: string[] = []
  const projectName = s.rootDir.split('/').pop() ?? 'Project'
  lines.push(`# ${projectName} — Structural Map`)
  lines.push('')
  lines.push(`> Généré le ${s.generatedAt} depuis commit \`${(s.commitHash ?? '—').slice(0, 12)}\``)
  lines.push(`> Source : \`codegraph analyze\` — 5 extracteurs déterministes, zéro LLM.`)
  return lines.join('\n')
}

function renderStats(s: GraphSnapshot): string {
  const lines: string[] = ['## 0. Stats', '']
  const stats = s.stats
  lines.push(
    `- Files: **${stats.totalFiles}** • Edges: **${stats.totalEdges}** • ` +
      `Orphans: ${stats.orphanCount} • Health: **${Math.round(stats.healthScore * 100)}%**`,
  )
  const tc = s.typedCalls
  if (tc) {
    lines.push(`- Typed signatures: **${tc.signatures.length}** • Call edges: **${tc.callEdges.length}**`)
  }
  const cy = s.cycles
  if (cy) {
    const nonGated = cy.filter((c) => !c.gated).length
    lines.push(`- Cycles: **${cy.length}** (non-gated: ${nonGated}, gated: ${cy.length - nonGated})`)
  }
  const tp = s.truthPoints
  if (tp) {
    const withMirrors = tp.filter((p) => p.mirrors.length > 0).length
    lines.push(`- Truth points: **${tp.length}** (with mirrors: ${withMirrors})`)
  }
  const df = s.dataFlows
  if (df) {
    const byKind: Record<string, number> = {}
    for (const f of df) byKind[f.entry.kind] = (byKind[f.entry.kind] ?? 0) + 1
    const summary = Object.entries(byKind)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, n]) => `${k}=${n}`)
      .join(', ')
    lines.push(`- Data flows: **${df.length}** (${summary})`)
  }
  const sm = s.stateMachines
  if (sm) {
    const withOrphans = sm.filter((m) => m.orphanStates.length > 0).length
    lines.push(`- State machines: **${sm.length}** (with orphan states: ${withOrphans})`)
  }

  // Phase 3.8 : deps / barrels / taint / DSM sur la stats-line pour qu'un
  // reviewer qui ne scroll pas en bas voit déjà le verdict de ces signaux.
  const pd = s.packageDeps
  if (pd) {
    const c = { missing: 0, unused: 0, dev: 0 }
    for (const i of pd) {
      if (i.kind === 'missing') c.missing++
      else if (i.kind === 'declared-unused') c.unused++
      else if (i.kind === 'devOnly') c.dev++
    }
    lines.push(
      `- Deps: **${c.missing}** missing · **${c.unused}** declared-unused · **${c.dev}** devOnly`,
    )
  }
  const br = s.barrels
  if (br && br.length > 0) {
    const low = br.filter((b) => b.lowValue).length
    lines.push(`- Barrels: **${br.length}** total · **${low}** low-value (< 2 consumers)`)
  }
  const tv = s.taintViolations
  if (tv) {
    const bySev = { critical: 0, high: 0, medium: 0, low: 0 }
    for (const v of tv) bySev[v.severity]++
    lines.push(
      `- Taint violations: **${tv.length}** ` +
      `(crit ${bySev.critical} · high ${bySev.high} · med ${bySev.medium} · low ${bySev.low})`,
    )
  }
  const dsm = s.dsm
  if (dsm) {
    const sccCount = dsm.levels.filter((l) => l.length >= 2).length
    lines.push(
      `- DSM: **${dsm.order.length}** containers · **${dsm.backEdges.length}** back-edges · **${sccCount}** SCC(s) of size ≥ 2`,
    )
  }

  // Module-level metrics — afficher les 5 hubs (PageRank) et 5 god-modules
  // (Henry-Kafura) pour orienter un reviewer vers les points architecturaux
  // critiques sans lui faire parcourir toutes les fiches.
  const mm = s.moduleMetrics
  if (mm && mm.length > 0) {
    const topPr = mm.slice(0, 5)  // déjà trié par PageRank desc côté extracteur
    lines.push('')
    lines.push('**Top hubs** (PageRank, import subgraph) :')
    for (const m of topPr) {
      lines.push(`  - \`${m.file}\` — PR=${m.pageRank.toFixed(3)} · in=${m.fanIn} · out=${m.fanOut}`)
    }
    const topHk = [...mm].sort((a, b) => b.henryKafura - a.henryKafura).slice(0, 5).filter((m) => m.henryKafura > 0)
    if (topHk.length > 0) {
      lines.push('')
      lines.push('**God-module candidates** (Henry-Kafura `(in×out)²×loc`) :')
      for (const m of topHk) {
        lines.push(`  - \`${m.file}\` — HK=${m.henryKafura.toLocaleString('en-US')} (in=${m.fanIn} × out=${m.fanOut}, loc=${m.loc})`)
      }
    }
  }
  return lines.join('\n')
}

// ─── Section 1 : Core flows ─────────────────────────────────────────────────

function renderCoreFlows(s: GraphSnapshot, opts: Required<MapBuilderOptions>): string {
  const df = s.dataFlows
  if (!df || df.length === 0) return ''

  // Les handlers polymorphes (ex: `handleSystemRoutes`) servent N routes mais
  // le BFS visite TOUT le body → chaque route partage les mêmes sinks.
  // Afficher N entrées identiques trompe le lecteur : il croit que chaque
  // route écrit dans chaque sink. Groupement par handler + liste des routes.
  // Les flows sans handler (arrows inline) restent individuels.
  interface HandlerGroup {
    key: string                    // handler key or synthetic id for inline
    kind: DataFlowEntryKind
    routes: string[]               // entry.id pour chaque flow partageant ce handler
    sample: DataFlow               // un flow représentatif pour inputType / file / sinks
  }

  const groups = new Map<string, HandlerGroup>()
  for (const f of df) {
    // Handler-dedupable : même handler ET même set de sinks = on groupe.
    // Si handler absent (arrow inline), chaque flow reste unique.
    const sinkKey = f.sinks
      .map((x) => `${x.kind}|${x.target}|${x.file}|${x.line}`)
      .sort()
      .join('#')
    const groupKey = f.entry.handler
      ? `${f.entry.kind}|${f.entry.handler}|${sinkKey}`
      : `__inline__|${f.entry.id}|${f.entry.file}:${f.entry.line}`

    const existing = groups.get(groupKey)
    if (existing) {
      existing.routes.push(f.entry.id)
    } else {
      groups.set(groupKey, {
        key: groupKey,
        kind: f.entry.kind,
        routes: [f.entry.id],
        sample: f,
      })
    }
  }

  const ranked = [...groups.values()]
    .sort((a, b) => {
      // Priorité : plus de sinks > plus de routes > plus de steps > id.
      if (a.sample.sinks.length !== b.sample.sinks.length) return b.sample.sinks.length - a.sample.sinks.length
      if (a.routes.length !== b.routes.length) return b.routes.length - a.routes.length
      if (a.sample.steps.length !== b.sample.steps.length) return b.sample.steps.length - a.sample.steps.length
      return a.sample.entry.id < b.sample.entry.id ? -1 : 1
    })
    .slice(0, opts.topCoreFlows)

  const lines: string[] = ['## 1. Core flows', '']
  lines.push(`Top entry-points par sinks. Handlers polymorphes (N routes → 1 fonction) regroupés.`)
  lines.push('')
  lines.push('| Kind | Handler | Routes | Steps | Sinks | Downstream |')
  lines.push('|---|---|---:|---:|---:|---:|')
  for (const g of ranked) {
    const ds = g.sample.downstream?.length ?? 0
    const handlerShort = g.sample.entry.handler
      ? path_basename(g.sample.entry.handler.split(':')[0]) + ':' + g.sample.entry.handler.split(':').slice(1).join(':')
      : g.sample.entry.id
    lines.push(`| \`${g.kind}\` | ${escapePipe(handlerShort)} | ${g.routes.length} | ${g.sample.steps.length} | ${g.sample.sinks.length} | ${ds} |`)
  }
  lines.push('')
  // Détail des top 3 groupes.
  for (const g of ranked.slice(0, 3)) {
    const title = g.routes.length === 1 ? g.routes[0] : `${g.sample.entry.kind} handler (${g.routes.length} routes)`
    lines.push(`### ${title}`)
    lines.push('')
    if (g.sample.entry.handler) {
      lines.push(`- Handler : \`${g.sample.entry.handler}\``)
    }
    lines.push(`- Entry file : \`${g.sample.entry.file}:${g.sample.entry.line}\``)
    if (g.sample.inputType) lines.push(`- Input type : \`${truncate(g.sample.inputType, 80)}\``)
    if (g.routes.length > 1) {
      const sorted = [...g.routes].sort()
      const shown = sorted.slice(0, 8).map((r) => `\`${escapePipe(r)}\``).join(', ')
      const extra = sorted.length > 8 ? ` …+${sorted.length - 8}` : ''
      lines.push(`- Routes gérées : ${shown}${extra}`)
      lines.push(`  _NB : sinks listés ci-dessous sont l'union pour TOUTES les routes ; non attribuables à une route spécifique sans isolation de branche._`)
    }
    const sinkSummary = summarizeSinks(g.sample)
    if (sinkSummary) lines.push(`- Sinks : ${sinkSummary}`)
    if (g.sample.downstream && g.sample.downstream.length > 0) {
      const dsIds = g.sample.downstream.map((d) => `\`${d.entry.id}\``).join(', ')
      lines.push(`- Downstream : ${dsIds}`)
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

function summarizeSinks(f: DataFlow): string {
  const byKind: Record<string, string[]> = {}
  for (const s of f.sinks) {
    if (!byKind[s.kind]) byKind[s.kind] = []
    if (s.target && !byKind[s.kind].includes(s.target)) byKind[s.kind].push(s.target)
  }
  const parts: string[] = []
  for (const kind of ['db-write', 'event-emit', 'http-response', 'bullmq-enqueue', 'mcp-return'] as const) {
    const targets = byKind[kind] ?? []
    if (targets.length === 0 && !f.sinks.some((s) => s.kind === kind)) continue
    if (targets.length === 0) {
      parts.push(`\`${kind}\``)
    } else {
      parts.push(`\`${kind}\` (${targets.slice(0, 4).map((t) => `\`${t}\``).join(', ')}${targets.length > 4 ? '…' : ''})`)
    }
  }
  return parts.join(' • ')
}

// ─── Section 2 : State machines ─────────────────────────────────────────────

function renderStateMachines(s: GraphSnapshot): string {
  const sm = s.stateMachines
  if (!sm || sm.length === 0) return ''

  const lines: string[] = ['## 2. State machines', '']
  for (const m of sm) {
    const states = m.states.map((v) => `\`${v}\``).join(' · ')
    const orphans = m.orphanStates.length > 0 ? ` — orphans: ${m.orphanStates.map((o) => `\`${o}\``).join(', ')}` : ''
    const byKind: Record<string, number> = {}
    for (const t of m.transitions) byKind[t.trigger.kind] = (byKind[t.trigger.kind] ?? 0) + 1
    const trigSummary = Object.entries(byKind)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, n]) => `${k}:${n}`)
      .join(' ')
    lines.push(`- **${m.concept}** [${states}] — ${m.transitions.length} transitions (${trigSummary})${orphans}`)
  }
  return lines.join('\n')
}

// ─── Section 3 : Truth points ───────────────────────────────────────────────

function renderTruthPoints(s: GraphSnapshot): string {
  const tp = s.truthPoints
  if (!tp || tp.length === 0) return ''

  // Filtrer : on garde les concepts avec mirrors OU >= 2 writers/readers/exposed
  // pour éviter un tableau de 93 lignes peu informatives.
  const interesting = tp.filter(
    (p) =>
      p.mirrors.length > 0 ||
      p.writers.length >= 2 ||
      p.readers.length >= 2 ||
      p.exposed.length >= 1,
  )
  if (interesting.length === 0) return ''

  const lines: string[] = ['## 3. Truth points', '']
  lines.push(`${interesting.length} concepts "actifs" (≥2 writers/readers, ou mirror, ou exposed). Total : ${tp.length}.`)
  lines.push('')
  lines.push('| Concept | Canonical | Mirrors | W | R | Exposed |')
  lines.push('|---|---|---|---:|---:|---|')
  for (const p of interesting.slice(0, 50)) {
    const mirrors = p.mirrors.length === 0
      ? '—'
      : p.mirrors
          .slice(0, 2)
          .map((m) => `${m.kind}:\`${truncate(m.key, 36)}\`${m.ttl ? ` ttl=${m.ttl}` : ''}`)
          .join(' · ') + (p.mirrors.length > 2 ? ' …' : '')
    const exposed = p.exposed.length === 0
      ? '—'
      : p.exposed
          .slice(0, 3)
          .map((e) => `\`${truncate(e.id, 28)}\``)
          .join(', ') + (p.exposed.length > 3 ? ' …' : '')
    const canonical = p.canonical ? `\`${p.canonical.name}\`` : '—'
    lines.push(`| \`${p.concept}\` | ${canonical} | ${mirrors} | ${p.writers.length} | ${p.readers.length} | ${exposed} |`)
  }
  if (interesting.length > 50) {
    lines.push('')
    lines.push(`_(${interesting.length - 50} concepts actifs supplémentaires non listés)_`)
  }

  // ── Expanded lineage : pour les concepts à forte activité, lister les
  // fichiers writers/readers explicitement. Accélère les refacto de schéma :
  // qui casser si on change la table X.
  const hotspots = interesting
    .filter(p => p.writers.length + p.readers.length >= 4)
    .sort((a, b) => (b.writers.length + b.readers.length) - (a.writers.length + a.readers.length))
    .slice(0, 15)

  if (hotspots.length > 0) {
    lines.push('')
    lines.push('### Lineage des hotspots (W ≥ 2 ou R ≥ 2)')
    lines.push('')
    lines.push('_Pour refacto de schéma : liste explicite des fichiers writer/reader._')
    lines.push('')
    for (const p of hotspots) {
      const writerFiles = uniqueFiles(p.writers.map(w => w.file))
      const readerFiles = uniqueFiles(p.readers.map(r => r.file))
      const wLine = writerFiles.length === 0
        ? '_(aucun writer)_'
        : writerFiles.map(f => `\`${shortenFile(f)}\``).join(', ')
      const rLine = readerFiles.length === 0
        ? '_(aucun reader)_'
        : readerFiles.map(f => `\`${shortenFile(f)}\``).join(', ')
      lines.push(`- **\`${p.concept}\`**`)
      lines.push(`  - W: ${wLine}`)
      lines.push(`  - R: ${rLine}`)
    }
  }

  return lines.join('\n')
}

function uniqueFiles(files: string[]): string[] {
  return [...new Set(files)].sort()
}

function shortenFile(f: string): string {
  // Keep last 3 path segments for readability while preserving context
  const parts = f.split('/')
  if (parts.length <= 3) return f
  return parts.slice(-3).join('/')
}

// ─── Section 4 : Cycles ─────────────────────────────────────────────────────

function renderCycles(s: GraphSnapshot): string {
  const cy = s.cycles
  if (!cy || cy.length === 0) return ''

  const lines: string[] = ['## 4. Cycles', '']
  const nonGated = cy.filter((c) => !c.gated)
  const gated = cy.filter((c) => c.gated)

  if (nonGated.length > 0) {
    lines.push('### Non-gated (risque de divergence)')
    lines.push('')
    for (const c of nonGated) lines.push(renderCycleLine(c))
    lines.push('')
  }
  if (gated.length > 0) {
    lines.push('### Gated')
    lines.push('')
    for (const c of gated) lines.push(renderCycleLine(c))
  }
  return lines.join('\n').trimEnd()
}

function renderCycleLine(c: Cycle): string {
  const nodes = c.nodes.map((n) => `\`${path_basename(n)}\``).join(' → ')
  const sccNote = c.sccSize > c.size ? ` (SCC ${c.sccSize} nœuds)` : ''
  const gates = c.gated
    ? ` — gates: ${c.gates
        .slice(0, 3)
        .map((g) => `\`${path_basename(g.file)}:${g.symbol}\``)
        .join(', ')}${c.gates.length > 3 ? '…' : ''}`
    : ''
  return `- ${nodes}${sccNote}${gates}`
}

// ─── Section 4.4 : Component health (I/A/D) ────────────────────────────────

function renderComponentMetrics(s: GraphSnapshot): string {
  const list = s.componentMetrics ?? []
  if (list.length === 0) return ''

  const lines: string[] = ['## 4.4. Component health (Martin I/A/D)', '']
  lines.push(
    'I = instability (Ce/(Ca+Ce)), A = abstractness (abstract/total), ' +
    'D = |A+I−1|. D≈0 = main sequence (équilibré). D≈1 = zone-of-pain ' +
    '(stable+concret) ou zone-of-uselessness (instable+abstract).',
  )
  lines.push('')
  lines.push('| Component | Files | Exports | Ca | Ce | I | A | D | Zone |')
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---|')

  // Cap à 40 composants max (priorité : D desc, déjà trié).
  const max = Math.min(list.length, 40)
  for (let i = 0; i < max; i++) {
    const m = list[i]
    const zone = classifyZone(m.instability, m.abstractness)
    lines.push(
      `| \`${m.component}\` | ${m.fileCount} | ${m.exportCount} | ${m.ca} | ${m.ce} | ` +
      `${m.instability.toFixed(2)} | ${m.abstractness.toFixed(2)} | ${m.distance.toFixed(2)} | ${zone} |`,
    )
  }
  if (list.length > max) {
    lines.push(`_… ${list.length - max} composants supplémentaires (distance plus faible)_`)
  }

  return lines.join('\n')
}

function classifyZone(I: number, A: number): string {
  // Zones qualitatives (seuils conventionnels) :
  //   - I haut (>0.7) + A bas (<0.3) = zone-of-uselessness
  //   - I bas (<0.3) + A bas (<0.3) = zone-of-pain
  //   - I bas + A haut = stable abstract (idéal bas de pile)
  //   - I haut + A haut = zone useless (rare)
  //   - sinon = main sequence
  if (I <= 0.3 && A <= 0.3) return '⚠️ pain'
  if (I >= 0.7 && A <= 0.3) return 'useful (top of stack)'
  if (I <= 0.3 && A >= 0.7) return 'stable abstract (ideal base)'
  if (I >= 0.7 && A >= 0.7) return '⚠️ useless'
  return 'main seq'
}

// ─── Section 4.5 : Env vars ─────────────────────────────────────────────────

function renderEnvUsage(s: GraphSnapshot): string {
  const list = s.envUsage ?? []
  if (list.length === 0) return ''

  const lines: string[] = ['## 4.5. Env vars', '']
  lines.push(`${list.length} variables d'env lues. \`🔒\` = nom identifié secret-like (KEY/TOKEN/SECRET/...).`)
  lines.push('')
  lines.push('| Var | Readers | No-default | Secret |')
  lines.push('|---|---:|---:|---|')

  // Tri : secrets d'abord, puis par nom.
  const sorted = [...list].sort((a, b) => {
    if (a.isSecret !== b.isSecret) return a.isSecret ? -1 : 1
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })

  for (const e of sorted.slice(0, 100)) {
    const noDefault = e.readers.filter((r) => !r.hasDefault).length
    const secret = e.isSecret ? '🔒' : '—'
    lines.push(`| \`${e.name}\` | ${e.readers.length} | ${noDefault} | ${secret} |`)
  }
  if (sorted.length > 100) {
    lines.push(`_… ${sorted.length - 100} variables supplémentaires_`)
  }

  return lines.join('\n')
}

// ─── Section 4.6 : Package deps hygiene ────────────────────────────────────

function renderPackageDeps(s: GraphSnapshot): string {
  const issues = s.packageDeps
  if (!issues || issues.length === 0) return ''

  const lines: string[] = ['## 4.6. Package deps hygiene', '']
  const counts = { missing: 0, 'declared-unused': 0, 'declared-runtime-asset': 0, devOnly: 0 }
  for (const i of issues) counts[i.kind]++
  lines.push(
    `${counts.missing} missing (build hazard) · ${counts['declared-unused']} declared-unused · ${counts['declared-runtime-asset']} runtime-asset (review before uninstall) · ${counts.devOnly} devOnly (misplaced in \`dependencies\`).`,
  )
  lines.push('')

  // Group by package.json.
  const byManifest = new Map<string, typeof issues>()
  for (const i of issues) {
    const arr = byManifest.get(i.packageJson) ?? []
    arr.push(i)
    byManifest.set(i.packageJson, arr)
  }

  for (const [manifest, list] of [...byManifest].sort()) {
    lines.push(`### \`${manifest}\` (${list.length})`)
    lines.push('')
    const byKind = new Map<string, typeof list>()
    for (const i of list) {
      const arr = byKind.get(i.kind) ?? []
      arr.push(i)
      byKind.set(i.kind, arr)
    }
    for (const kind of ['missing', 'devOnly', 'declared-unused'] as const) {
      const group = byKind.get(kind)
      if (!group || group.length === 0) continue
      const icon = kind === 'missing' ? '✗' : kind === 'devOnly' ? '◐' : '–'
      for (const i of group) {
        const loc = i.declaredIn ? ` _(${i.declaredIn})_` : ''
        const importers = i.importers.length === 0
          ? ''
          : ` — ${i.importers.slice(0, 3).map((f) => `\`${f}\``).join(', ')}${i.importers.length > 3 ? ` …+${i.importers.length - 3}` : ''}`
        lines.push(`- ${icon} **${kind}** \`${i.packageName}\`${loc}${importers}`)
      }
    }
    lines.push('')
  }

  return lines.join('\n').trimEnd()
}

// ─── Section 4.7 : Barrels ──────────────────────────────────────────────────

function renderBarrels(s: GraphSnapshot): string {
  const list = s.barrels ?? []
  if (list.length === 0) return ''

  const low = list.filter((b) => b.lowValue)
  const lines: string[] = ['## 4.7. Barrels', '']
  lines.push(
    `${list.length} barrel file(s) détectés (100 % ré-exports). ` +
    `${low.length} low-value (consumers < 2) — candidats inline.`,
  )
  if (low.length > 0) {
    lines.push('')
    lines.push('| File | Re-exports | Consumers |')
    lines.push('|---|---:|---:|')
    for (const b of low) {
      lines.push(`| \`${b.file}\` | ${b.reExportCount} | ${b.consumerCount} |`)
    }
  }
  return lines.join('\n').trimEnd()
}

// ─── Section 4.8 : Taint violations ────────────────────────────────────────

function renderTaintViolations(s: GraphSnapshot): string {
  const list = s.taintViolations
  if (!list || list.length === 0) return ''

  const lines: string[] = ['## 4.8. Taint violations', '']
  const bySev = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const v of list) bySev[v.severity]++
  lines.push(
    `${list.length} flux source → sink sans sanitizer. ` +
    `crit ${bySev.critical} · high ${bySev.high} · med ${bySev.medium} · low ${bySev.low}.`,
  )
  lines.push('')

  // Tri : severity desc puis file.
  const sevRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }
  const sorted = [...list].sort((a, b) => {
    if (sevRank[a.severity] !== sevRank[b.severity]) return sevRank[a.severity] - sevRank[b.severity]
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    return a.line - b.line
  })

  for (const v of sorted.slice(0, 30)) {
    const sevIcon = v.severity === 'critical' ? '🔴'
                  : v.severity === 'high' ? '🟠'
                  : v.severity === 'medium' ? '🟡'
                  : '⚪'
    const sym = v.symbol ? ` (\`${v.symbol}\`)` : ''
    lines.push(`- ${sevIcon} **${v.severity}** \`${v.sourceName}\` → \`${v.sinkName}\` — \`${v.file}:${v.line}\`${sym}`)
    for (const step of v.chain) {
      lines.push(`    - ${step.kind === 'source' ? '┌' : step.kind === 'sink' ? '└' : '│'} L${step.line}: ${step.detail}`)
    }
  }
  if (sorted.length > 30) {
    lines.push('')
    lines.push(`_(${sorted.length - 30} violations supplémentaires non listées)_`)
  }

  return lines.join('\n').trimEnd()
}

// ─── Section 4.9 : DSM ──────────────────────────────────────────────────────

function renderDsmSection(s: GraphSnapshot): string {
  const dsm = s.dsm
  if (!dsm || dsm.order.length === 0) return ''

  const lines: string[] = ['## 4.9. Dependency Structure Matrix', '']
  const sccCount = dsm.levels.filter((l) => l.length >= 2).length
  lines.push(
    `Container-level (import edges). ${dsm.order.length} nodes, ${dsm.backEdges.length} back-edges, ${sccCount} SCC(s) ≥ 2. ` +
    `Forward deps \`•\` au-dessus de la diagonale ; back-edges \`↑\` en-dessous = cycles.`,
  )
  lines.push('')
  // Reuse the ASCII renderer — wrapped in ``` to preserve alignment.
  lines.push('```')
  lines.push(renderDsm(dsm, { includeLegend: true }).trimEnd())
  lines.push('```')
  return lines.join('\n')
}

// ─── Section 5 : Modules ────────────────────────────────────────────────────

interface ModuleIndices {
  byFromEvent: Map<string, GraphEdge[]>
  byToEvent: Map<string, GraphEdge[]>
  byFromDb: Map<string, GraphEdge[]>
  byToDb: Map<string, GraphEdge[]>
  sigsByFile: Map<string, TypedSignature[]>
  callsOutByFile: Map<string, TypedCallEdge[]>
  cyclesByFile: Map<string, Cycle[]>
  tpByFile: Map<string, Array<{ role: 'writer' | 'reader' | 'canonical' | 'mirror'; tp: TruthPoint }>>
  smByFile: Map<string, StateMachine[]>
}

function buildEventDbIndices(edges: GraphEdge[]): {
  byFromEvent: Map<string, GraphEdge[]>
  byToEvent: Map<string, GraphEdge[]>
  byFromDb: Map<string, GraphEdge[]>
  byToDb: Map<string, GraphEdge[]>
} {
  const byFromEvent = new Map<string, GraphEdge[]>()
  const byToEvent = new Map<string, GraphEdge[]>()
  const byFromDb = new Map<string, GraphEdge[]>()
  const byToDb = new Map<string, GraphEdge[]>()
  for (const e of edges) {
    if (e.type === 'event') {
      push(byFromEvent, e.from, e)
      push(byToEvent, e.to, e)
    } else if (e.type === 'db-table') {
      push(byFromDb, e.from, e)
      push(byToDb, e.to, e)
    }
  }
  return { byFromEvent, byToEvent, byFromDb, byToDb }
}

function buildTypedCallIndices(s: GraphSnapshot): {
  sigsByFile: Map<string, TypedSignature[]>
  callsOutByFile: Map<string, TypedCallEdge[]>
} {
  const sigsByFile = new Map<string, TypedSignature[]>()
  const callsOutByFile = new Map<string, TypedCallEdge[]>()
  if (s.typedCalls) {
    for (const sig of s.typedCalls.signatures) push(sigsByFile, sig.file, sig)
    for (const e of s.typedCalls.callEdges) {
      const [fromFile] = e.from.split(':')
      if (fromFile) push(callsOutByFile, fromFile, e)
    }
  }
  return { sigsByFile, callsOutByFile }
}

function buildSemanticIndices(s: GraphSnapshot): {
  cyclesByFile: Map<string, Cycle[]>
  tpByFile: Map<string, Array<{ role: 'writer' | 'reader' | 'canonical' | 'mirror'; tp: TruthPoint }>>
  smByFile: Map<string, StateMachine[]>
} {
  const cyclesByFile = new Map<string, Cycle[]>()
  if (s.cycles) {
    for (const c of s.cycles) {
      for (const n of new Set(c.nodes)) push(cyclesByFile, n, c)
    }
  }
  const tpByFile = new Map<string, Array<{ role: 'writer' | 'reader' | 'canonical' | 'mirror'; tp: TruthPoint }>>()
  if (s.truthPoints) {
    for (const tp of s.truthPoints) {
      for (const w of tp.writers) push(tpByFile, w.file, { role: 'writer', tp })
      for (const r of tp.readers) push(tpByFile, r.file, { role: 'reader', tp })
      for (const m of tp.mirrors) push(tpByFile, m.file, { role: 'mirror', tp })
    }
  }
  const smByFile = new Map<string, StateMachine[]>()
  if (s.stateMachines) {
    for (const m of s.stateMachines) {
      const files = new Set(m.transitions.map((t) => t.file))
      for (const f of files) push(smByFile, f, m)
    }
  }
  return { cyclesByFile, tpByFile, smByFile }
}

function selectFilesForFiches(s: GraphSnapshot, opts: Required<MapBuilderOptions>): string[] {
  const inDegree = new Map<string, number>()
  for (const e of s.edges) {
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1)
  }
  const fileNodes = s.nodes.filter((n) => n.type === 'file')
  const isEntryPoint = (id: string): boolean => {
    const n = fileNodes.find((x) => x.id === id)
    return n?.status === 'entry-point'
  }
  return fileNodes
    .filter((n) => (inDegree.get(n.id) ?? 0) >= opts.minIndegree || isEntryPoint(n.id))
    .map((n) => n.id)
    .sort()
    .slice(0, opts.maxModulesInFiches)
}

function renderModules(s: GraphSnapshot, opts: Required<MapBuilderOptions>): string {
  const selected = selectFilesForFiches(s, opts)
  if (selected.length === 0) return ''

  const indices: ModuleIndices = {
    ...buildEventDbIndices(s.edges),
    ...buildTypedCallIndices(s),
    ...buildSemanticIndices(s),
  }

  const lines: string[] = ['## 5. Modules', '']
  lines.push(`Fiches pour ${selected.length} fichier(s) (in-degree ≥ ${opts.minIndegree} ou entry-point).`)
  lines.push('')

  for (const file of selected) {
    lines.push(renderModuleFiche({
      file,
      sigs: indices.sigsByFile.get(file) ?? [],
      callsOut: indices.callsOutByFile.get(file) ?? [],
      listens: indices.byToEvent.get(file) ?? [],
      emits: indices.byFromEvent.get(file) ?? [],
      reads: indices.byToDb.get(file) ?? [],
      writes: indices.byFromDb.get(file) ?? [],
      cycles: indices.cyclesByFile.get(file) ?? [],
      tpRoles: indices.tpByFile.get(file) ?? [],
      sms: indices.smByFile.get(file) ?? [],
      opts,
    }))
  }

  return lines.join('\n').trimEnd()
}

interface RenderModuleFicheArgs {
  file: string
  sigs: TypedSignature[]
  callsOut: TypedCallEdge[]
  listens: GraphEdge[]
  emits: GraphEdge[]
  reads: GraphEdge[]
  writes: GraphEdge[]
  cycles: Cycle[]
  tpRoles: Array<{ role: 'writer' | 'reader' | 'canonical' | 'mirror'; tp: TruthPoint }>
  sms: StateMachine[]
  opts: Required<MapBuilderOptions>
}

function renderFicheSignatures(sigs: TypedSignature[], opts: Required<MapBuilderOptions>): string[] {
  if (sigs.length === 0) return []
  const out: string[] = [`**Exports** (${sigs.length})`]
  const slice = [...sigs].sort((a, b) => a.line - b.line).slice(0, opts.signaturesPerFile)
  for (const sig of slice) {
    const params = sig.params.map((p) => `${p.name}${p.optional ? '?' : ''}: ${truncate(p.type, 40)}`).join(', ')
    out.push(`- L${sig.line} \`[${sig.kind}] ${sig.exportName}(${params}): ${truncate(sig.returnType, 60)}\``)
  }
  if (sigs.length > slice.length) out.push(`- … ${sigs.length - slice.length} de plus`)
  out.push('')
  return out
}

function renderFicheCallsOut(callsOut: TypedCallEdge[], opts: Required<MapBuilderOptions>): string[] {
  if (callsOut.length === 0) return []
  const byTarget = new Map<string, number>()
  for (const e of callsOut) byTarget.set(e.to, (byTarget.get(e.to) ?? 0) + 1)
  const sorted = [...byTarget.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, opts.callEdgesPerFile)
  const rendered = sorted
    .map(([target, n]) => `\`${path_basename_with_symbol(target)}\`${n > 1 ? ` ×${n}` : ''}`)
    .join(', ')
  const extra = byTarget.size > sorted.length ? ` • +${byTarget.size - sorted.length}` : ''
  return [`**Calls out** : ${rendered}${extra}`, '']
}

function renderFicheDb(reads: GraphEdge[], writes: GraphEdge[]): string[] {
  const readTables = uniqueTableLabels(reads)
  const writeTables = uniqueTableLabels(writes)
  if (readTables.length === 0 && writeTables.length === 0) return []
  const parts: string[] = []
  if (writeTables.length > 0) parts.push(`writes \`${writeTables.join('`, `')}\``)
  if (readTables.length > 0) parts.push(`reads \`${readTables.join('`, `')}\``)
  return [`**DB** : ${parts.join(' • ')}`, '']
}

function renderFicheCycles(cycles: Cycle[]): string[] {
  if (cycles.length === 0) return []
  const summary = cycles
    .map((c) => `\`${c.gated ? 'gated' : 'non-gated'}\` ${c.nodes.map(path_basename).join('→')}`)
    .slice(0, 2)
    .join(' • ')
  return [`**Cycles** : ${summary}${cycles.length > 2 ? ` +${cycles.length - 2}` : ''}`, '']
}

function renderFicheTruthRoles(
  tpRoles: Array<{ role: 'writer' | 'reader' | 'canonical' | 'mirror'; tp: TruthPoint }>,
): string[] {
  if (tpRoles.length === 0) return []
  const seen = new Set<string>()
  const byRole: Record<string, string[]> = {}
  for (const r of tpRoles) {
    const k = `${r.role}|${r.tp.concept}`
    if (seen.has(k)) continue
    seen.add(k)
    if (!byRole[r.role]) byRole[r.role] = []
    byRole[r.role].push(r.tp.concept)
  }
  const bits: string[] = []
  for (const role of ['canonical', 'writer', 'reader', 'mirror']) {
    const arr = byRole[role]
    if (!arr || arr.length === 0) continue
    bits.push(`${role} of \`${arr.slice(0, 4).join('`, `')}\`${arr.length > 4 ? ` +${arr.length - 4}` : ''}`)
  }
  if (bits.length === 0) return []
  return [`**Truth** : ${bits.join(' • ')}`, '']
}

function renderModuleFiche(args: RenderModuleFicheArgs): string {
  const {
    file, sigs, callsOut, listens, emits, reads, writes,
    cycles, tpRoles, sms, opts,
  } = args
  const anchor = anchorFor(file)
  const out: string[] = [`### ${file}  <a id="${anchor}"></a>`, '']

  out.push(...renderFicheSignatures(sigs, opts))
  out.push(...renderFicheCallsOut(callsOut, opts))

  const emitNames = uniqueLabels(emits)
  if (emitNames.length > 0) {
    out.push(`**Emits** : ${emitNames.map((e) => `\`${e}\``).join(', ')}`, '')
  }
  const listenNames = uniqueLabels(listens)
  if (listenNames.length > 0) {
    out.push(`**Listens** : ${listenNames.map((e) => `\`${e}\``).join(', ')}`, '')
  }

  out.push(...renderFicheDb(reads, writes))

  if (sms.length > 0) {
    const concepts = sms.map((m) => `\`${m.concept}\``).join(', ')
    out.push(`**State** : writes transitions de ${concepts}`, '')
  }

  out.push(...renderFicheCycles(cycles))
  out.push(...renderFicheTruthRoles(tpRoles))

  return out.join('\n')
}

// ─── Section 6 : Index ──────────────────────────────────────────────────────

function renderIndex(s: GraphSnapshot): string {
  const lines: string[] = ['## 6. Index', '']

  // Events.
  const eventEmitters = new Map<string, Set<string>>()
  const eventListeners = new Map<string, Set<string>>()
  for (const e of s.edges) {
    if (e.type !== 'event') continue
    const label = e.label ?? '(unknown)'
    if (!eventEmitters.has(label)) eventEmitters.set(label, new Set())
    eventEmitters.get(label)!.add(e.from)
    if (!eventListeners.has(label)) eventListeners.set(label, new Set())
    eventListeners.get(label)!.add(e.to)
  }
  if (eventEmitters.size > 0) {
    lines.push('### Events')
    lines.push('')
    const all = new Set([...eventEmitters.keys(), ...eventListeners.keys()])
    for (const ev of [...all].sort()) {
      const em = [...(eventEmitters.get(ev) ?? new Set<string>())].sort().map(path_basename)
      const lis = [...(eventListeners.get(ev) ?? new Set<string>())].sort().map(path_basename)
      lines.push(`- \`${ev}\` — emitters: ${em.slice(0, 3).join(', ') || '—'}${em.length > 3 ? ` +${em.length - 3}` : ''} | listeners: ${lis.slice(0, 3).join(', ') || '—'}${lis.length > 3 ? ` +${lis.length - 3}` : ''}`)
    }
    lines.push('')
  }

  // Tables.
  const tableReaders = new Map<string, Set<string>>()
  const tableWriters = new Map<string, Set<string>>()
  for (const e of s.edges) {
    if (e.type !== 'db-table') continue
    const label = e.label ?? ''
    const table = label.startsWith('table:') ? label.slice('table:'.length) : label
    if (!tableWriters.has(table)) tableWriters.set(table, new Set())
    tableWriters.get(table)!.add(e.from)
    if (!tableReaders.has(table)) tableReaders.set(table, new Set())
    tableReaders.get(table)!.add(e.to)
  }
  if (tableReaders.size > 0) {
    lines.push('### Tables')
    lines.push('')
    const all = new Set([...tableReaders.keys(), ...tableWriters.keys()])
    for (const t of [...all].sort()) {
      const w = [...(tableWriters.get(t) ?? new Set<string>())].sort().map(path_basename)
      const r = [...(tableReaders.get(t) ?? new Set<string>())].sort().map(path_basename)
      lines.push(`- \`${t}\` — writers: ${w.slice(0, 3).join(', ') || '—'}${w.length > 3 ? ` +${w.length - 3}` : ''} | readers: ${r.slice(0, 3).join(', ') || '—'}${r.length > 3 ? ` +${r.length - 3}` : ''}`)
    }
  }

  return lines.join('\n').trimEnd()
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  if (!m.has(k)) m.set(k, [])
  m.get(k)!.push(v)
}

function path_basename(p: string): string {
  return p.split('/').pop() ?? p
}

function path_basename_with_symbol(idWithSym: string): string {
  // "path/to/file.ts:symbolName" → "file.ts:symbolName"
  const [file, ...rest] = idWithSym.split(':')
  const base = path_basename(file)
  return rest.length > 0 ? `${base}:${rest.join(':')}` : base
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

function escapePipe(s: string): string {
  return s.replace(/\|/g, '\\|')
}

function uniqueLabels(edges: GraphEdge[]): string[] {
  const set = new Set<string>()
  for (const e of edges) if (e.label) set.add(e.label)
  return [...set].sort()
}

function uniqueTableLabels(edges: GraphEdge[]): string[] {
  const set = new Set<string>()
  for (const e of edges) {
    if (!e.label) continue
    const t = e.label.startsWith('table:') ? e.label.slice('table:'.length) : e.label
    set.add(t)
  }
  return [...set].sort()
}

function anchorFor(file: string): string {
  return file.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
}
