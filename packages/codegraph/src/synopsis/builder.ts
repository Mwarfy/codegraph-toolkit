// ADR-001
/**
 * CodeGraph Synopsis Builder
 *
 * Pure function `snapshot → structured JSON → markdown`.
 * No LLM, no I/O, no randomness. Same snapshot = byte-equivalent output.
 *
 * Three levels of zoom (C4 model):
 *   1. Context    — the whole project in ≤500 tokens (containers + top hubs + stats)
 *   2. Containers — zoom per container (≤1000 tokens) with components inside
 *   3. Components — zoom per container's internals (≤1500 tokens) with intra-component flows
 *
 * Level 4 (Code / functions) is already served by `codegraph_symbol`; we don't double it.
 */

// ADR-001: synopsis builder pur, zéro LLM, déterministe

import type { GraphSnapshot, GraphNode, GraphEdge, EdgeType } from '../core/types.js'
import { extractTensions, type Tension } from './tensions.js'
export type { Tension, TensionKind } from './tensions.js'

// ─── Public types ────────────────────────────────────────────────────────────

export interface HubEntry {
  id: string
  inDegree: number
  tags: string[]
  container: string
  /** ADRs gouvernant ce fichier (depuis marqueurs `// ADR-NNN` du code). */
  adrs?: string[]
}

/**
 * Suggestion d'ancrage ADR : fichier load-bearing (in-degree élevé OU
 * truth-point) qui n'a aucun marqueur `// ADR-NNN`. Signal au dev :
 * "ce fichier est central, intentionnel qu'aucun ADR ne le couvre ?"
 */
export interface AdrAnchorSuggestion {
  file: string
  inDegree: number
  reason: 'top-hub' | 'truth-point' | 'top-hub+truth-point'
}

export interface ComponentEntry {
  id: string                  // e.g. "sentinel-core/src/kernel"
  label: string               // e.g. "kernel"
  fileCount: number
  inDegree: number            // edges whose target is a file inside this component
  outDegree: number
  topFiles: Array<{ id: string; label: string; inDegree: number; adrs?: string[] }>
  tags: string[]
  /** ADRs distinct gouvernant au moins un fichier de ce composant. */
  adrs?: string[]
}

export interface CrossEdge {
  from: string                // container id
  to: string                  // container id
  type: EdgeType
  count: number
  samples: string[]           // up to 3 labels or from→to file pairs
}

export interface EventMapping {
  label: string
  emitters: string[]          // up to 2 short file ids
  listeners: string[]         // up to 2 short file ids
}

export interface ContainerEntry {
  id: string                  // e.g. "sentinel-core"
  label: string
  fileCount: number
  orphanCount: number
  entryPoints: string[]       // file ids
  topHubs: HubEntry[]         // top 15 intra-container files by in-degree
  components: ComponentEntry[]
  events: { emits: string[]; listens: string[]; mappings: EventMapping[] }
  routes: string[]            // route labels this container exposes (incoming route edges)
  tables: string[]            // db tables this container touches
  /** ADRs distinct gouvernant au moins un fichier du container. */
  adrs?: string[]
}

/**
 * Compteurs phase 3.8 (deps / barrels / taint / DSM). Présent uniquement
 * pour les snapshots récents. Permet à un agent LLM d'obtenir les signaux
 * d'alerte (missing deps, taint violations, cycles architecturaux) sans
 * charger MAP.md complet.
 */
export interface Phase38Summary {
  packageDeps?: { missing: number; declaredUnused: number; devOnly: number }
  barrels?: { total: number; lowValue: number }
  taint?: { total: number; critical: number; high: number; medium: number; low: number }
  dsm?: { containers: number; backEdges: number; sccSizeGt1: number }
}

export interface SynopsisJSON {
  version: '1'
  generatedAt: string
  commitHash?: string
  stats: {
    totalFiles: number
    totalEdges: number
    orphanCount: number
    entryPointCount: number
    healthScore: number
  }
  edgesByType: Partial<Record<EdgeType, number>>
  containers: ContainerEntry[]
  topHubs: HubEntry[]          // global top-10
  crossContainerEdges: CrossEdge[]
  /** Phase 3.8 counters (optional — absent pour les vieux snapshots). */
  phase38?: Phase38Summary
  /** Suggestions d'ancrage ADR (Lien 1+2 ADR-toolkit). Présent si options.adrMarkers fourni. */
  adrSuggestions?: AdrAnchorSuggestion[]
  /**
   * Tensions actives — convocations courtes pointant vers des frictions
   * dans le code (cycles, orphelins, FSM dead, truth-points sans cache,
   * etc.). Chacune a un testHint pour rendre l'hypothèse vérifiable.
   * Toujours présent — vide si aucune tension détectée.
   */
  tensions: Tension[]
}

/**
 * Options pour `buildSynopsis`. Reste pure : si options.adrMarkers est passé,
 * la dérivation est déterministe (même input → même output). Pas d'I/O dans
 * le builder lui-même — l'appelant collecte les marqueurs (cf.
 * `synopsis/adr-markers.ts::collectAdrMarkers`).
 */
export interface SynopsisOptions {
  /**
   * Map `fileId → ADR_numbers[]` collectée hors-builder par grep des
   * marqueurs `// ADR-NNN` dans le code source. Quand fournie :
   *   - HubEntry.adrs / ComponentEntry.adrs / ContainerEntry.adrs sont peuplés
   *   - SynopsisJSON.adrSuggestions liste les fichiers load-bearing sans marqueur
   * Optionnel : un projet sans ADRs ne fournit rien, le synopsis reste
   * identique à avant ce refactor.
   */
  adrMarkers?: Map<string, string[]>
  /** Seuil in-degree au-delà duquel un fichier est considéré load-bearing. */
  hubThreshold?: number
}

// ─── Build ───────────────────────────────────────────────────────────────────

interface SynopsisCtx {
  files: GraphNode[]
  edges: GraphEdge[]
  inDeg: Map<string, number>
  outDeg: Map<string, number>
  containerOf: (fileId: string) => string
  adrMarkers?: Map<string, string[]>
  hubThreshold: number
  adrsFor: (fileId: string) => string[] | undefined
}

function buildSynopsisCtx(snapshot: GraphSnapshot, options: SynopsisOptions): SynopsisCtx {
  const files = snapshot.nodes.filter(n => n.type === 'file')
  const edges = snapshot.edges
  const adrMarkers = options.adrMarkers
  const hubThreshold = options.hubThreshold ?? 15
  const inDeg = new Map<string, number>()
  const outDeg = new Map<string, number>()
  for (const e of edges) {
    inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1)
    outDeg.set(e.from, (outDeg.get(e.from) || 0) + 1)
  }
  const containerOf = (fileId: string): string => fileId.split('/')[0] || fileId
  const adrsFor = (fileId: string): string[] | undefined => adrMarkers?.get(fileId)
  return { files, edges, inDeg, outDeg, containerOf, adrMarkers, hubThreshold, adrsFor }
}

function buildHubEntry(file: GraphNode, ctx: SynopsisCtx, container: string): HubEntry {
  const entry: HubEntry = {
    id: file.id,
    inDegree: ctx.inDeg.get(file.id) || 0,
    tags: file.tags,
    container,
  }
  const adrs = ctx.adrsFor(file.id)
  if (adrs) entry.adrs = adrs
  return entry
}

function rankHubs(files: GraphNode[], ctx: SynopsisCtx, container: string, limit: number): HubEntry[] {
  return files
    .map(f => buildHubEntry(f, ctx, container))
    .filter(h => h.inDegree > 0)
    .sort((a, b) => b.inDegree - a.inDegree || a.id.localeCompare(b.id))
    .slice(0, limit)
}

interface ContainerEventState {
  emitsSet: Set<string>
  listensSet: Set<string>
  routeSet: Set<string>
  tableSet: Set<string>
  evEmits: Map<string, string[]>
  evListens: Map<string, string[]>
}

function recordEventEdge(
  e: GraphEdge,
  cFileIds: Set<string>,
  state: ContainerEventState,
): void {
  if (!e.label) return
  if (cFileIds.has(e.from)) {
    state.emitsSet.add(e.label)
    const arr = state.evEmits.get(e.label) || []
    if (!arr.includes(e.from)) arr.push(e.from)
    state.evEmits.set(e.label, arr)
  }
  if (cFileIds.has(e.to)) {
    state.listensSet.add(e.label)
    const arr = state.evListens.get(e.label) || []
    if (!arr.includes(e.to)) arr.push(e.to)
    state.evListens.set(e.label, arr)
  }
}

function collectContainerEvents(edges: GraphEdge[], cFileIds: Set<string>): ContainerEventState {
  const state: ContainerEventState = {
    emitsSet: new Set(),
    listensSet: new Set(),
    routeSet: new Set(),
    tableSet: new Set(),
    evEmits: new Map(),
    evListens: new Map(),
  }
  for (const e of edges) {
    if (e.type === 'event') recordEventEdge(e, cFileIds, state)
    else if (e.type === 'route' && e.label && cFileIds.has(e.to)) state.routeSet.add(e.label)
    else if (e.type === 'db-table' && e.label && (cFileIds.has(e.from) || cFileIds.has(e.to))) state.tableSet.add(e.label)
  }
  return state
}

function buildContainerEntry(cid: string, ctx: SynopsisCtx): ContainerEntry {
  const cFiles = ctx.files.filter(f => ctx.containerOf(f.id) === cid)
  const cFileIds = new Set(cFiles.map(f => f.id))

  const components = buildComponents(cid, cFiles, ctx.edges, ctx.inDeg, ctx.outDeg, ctx.adrMarkers)
  const entryPoints = cFiles.filter(f => f.status === 'entry-point').map(f => f.id).sort()
  const intraHubs = rankHubs(cFiles, ctx, cid, 15)

  const ev = collectContainerEvents(ctx.edges, cFileIds)
  const allEventLabels = Array.from(new Set([...ev.emitsSet, ...ev.listensSet])).sort()
  const mappings: EventMapping[] = allEventLabels.map(label => ({
    label,
    emitters: (ev.evEmits.get(label) || []).sort().slice(0, 2),
    listeners: (ev.evListens.get(label) || []).sort().slice(0, 2),
  }))

  let containerAdrs: string[] | undefined
  if (ctx.adrMarkers) {
    const set = new Set<string>()
    for (const f of cFiles) {
      const arr = ctx.adrMarkers.get(f.id)
      if (arr) for (const a of arr) set.add(a)
    }
    if (set.size > 0) containerAdrs = [...set].sort()
  }

  return {
    id: cid,
    label: cid,
    fileCount: cFiles.length,
    orphanCount: cFiles.filter(f => f.status === 'orphan').length,
    entryPoints,
    topHubs: intraHubs,
    components,
    events: {
      emits: Array.from(ev.emitsSet).sort(),
      listens: Array.from(ev.listensSet).sort(),
      mappings,
    },
    routes: Array.from(ev.routeSet).sort(),
    tables: Array.from(ev.tableSet).sort(),
    ...(containerAdrs ? { adrs: containerAdrs } : {}),
  }
}

function buildCrossContainerEdges(edges: GraphEdge[], containerOf: (id: string) => string): CrossEdge[] {
  const crossMap = new Map<string, CrossEdge>()
  for (const e of edges) {
    const cf = containerOf(e.from)
    const ct = containerOf(e.to)
    if (cf === ct) continue
    const key = `${cf}|${ct}|${e.type}`
    const existing = crossMap.get(key)
    if (existing) {
      existing.count++
      if (existing.samples.length < 3 && e.label && !existing.samples.includes(e.label)) {
        existing.samples.push(e.label)
      }
    } else {
      crossMap.set(key, { from: cf, to: ct, type: e.type, count: 1, samples: e.label ? [e.label] : [] })
    }
  }
  return Array.from(crossMap.values()).sort(
    (a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.type.localeCompare(b.type),
  )
}

function buildPhase38Summary(snapshot: GraphSnapshot): Phase38Summary | undefined {
  const phase38Parts: Phase38Summary = {}
  if (snapshot.packageDeps) {
    const c = { missing: 0, declaredUnused: 0, devOnly: 0 }
    for (const i of snapshot.packageDeps) {
      if (i.kind === 'missing') c.missing++
      else if (i.kind === 'declared-unused') c.declaredUnused++
      else if (i.kind === 'devOnly') c.devOnly++
    }
    phase38Parts.packageDeps = c
  }
  if (snapshot.barrels) {
    phase38Parts.barrels = {
      total: snapshot.barrels.length,
      lowValue: snapshot.barrels.filter((b) => b.lowValue).length,
    }
  }
  if (snapshot.taintViolations) {
    const sev = { critical: 0, high: 0, medium: 0, low: 0 }
    for (const v of snapshot.taintViolations) sev[v.severity]++
    phase38Parts.taint = { total: snapshot.taintViolations.length, ...sev }
  }
  if (snapshot.dsm) {
    phase38Parts.dsm = {
      containers: snapshot.dsm.order.length,
      backEdges: snapshot.dsm.backEdges.length,
      sccSizeGt1: snapshot.dsm.levels.filter((l) => l.length >= 2).length,
    }
  }
  return Object.keys(phase38Parts).length > 0 ? phase38Parts : undefined
}

/**
 * ADR anchor suggestions (Lien 1+2) — fichier load-bearing (in-degree
 * ≥ hubThreshold OU tag truth-point) sans aucun marqueur `// ADR-NNN`.
 * Signal au dev sans bloquer (intentionnel possible : utility libs,
 * glue code).
 */
function buildAdrSuggestions(snapshot: GraphSnapshot, ctx: SynopsisCtx): AdrAnchorSuggestion[] | undefined {
  if (!ctx.adrMarkers) return undefined
  const truthPointSet = new Set<string>()
  const tps = (snapshot as { truthPoints?: Array<{ file?: string; id?: string }> }).truthPoints
  if (tps) {
    for (const tp of tps) {
      const fid = tp.file || tp.id
      if (fid) truthPointSet.add(fid)
    }
  }
  const suggestions: AdrAnchorSuggestion[] = []
  for (const f of ctx.files) {
    if (ctx.adrMarkers.has(f.id)) continue
    const ind = ctx.inDeg.get(f.id) || 0
    const isHub = ind >= ctx.hubThreshold
    const isTruth = truthPointSet.has(f.id)
    if (!isHub && !isTruth) continue
    const reason: AdrAnchorSuggestion['reason'] =
      isHub && isTruth ? 'top-hub+truth-point' : isHub ? 'top-hub' : 'truth-point'
    suggestions.push({ file: f.id, inDegree: ind, reason })
  }
  suggestions.sort((a, b) => b.inDegree - a.inDegree || a.file.localeCompare(b.file))
  return suggestions
}

export function buildSynopsis(snapshot: GraphSnapshot, options: SynopsisOptions = {}): SynopsisJSON {
  const ctx = buildSynopsisCtx(snapshot, options)
  const topHubs = rankHubs(ctx.files, ctx, '', 10)
    .map(h => ({ ...h, container: ctx.containerOf(h.id) }))

  const containerIds = Array.from(new Set(ctx.files.map(f => ctx.containerOf(f.id)))).sort()
  const containers: ContainerEntry[] = containerIds.map(cid => buildContainerEntry(cid, ctx))

  const crossContainerEdges = buildCrossContainerEdges(ctx.edges, ctx.containerOf)

  const edgesByType: Partial<Record<EdgeType, number>> = {}
  for (const e of ctx.edges) edgesByType[e.type] = (edgesByType[e.type] || 0) + 1

  const phase38 = buildPhase38Summary(snapshot)
  const adrSuggestions = buildAdrSuggestions(snapshot, ctx)

  return {
    version: '1',
    generatedAt: snapshot.generatedAt,
    commitHash: snapshot.commitHash,
    stats: {
      totalFiles: snapshot.stats.totalFiles,
      totalEdges: snapshot.stats.totalEdges,
      orphanCount: snapshot.stats.orphanCount,
      entryPointCount: snapshot.stats.entryPointCount,
      healthScore: snapshot.stats.healthScore,
    },
    edgesByType,
    containers,
    topHubs,
    crossContainerEdges,
    ...(phase38 ? { phase38 } : {}),
    ...(adrSuggestions ? { adrSuggestions } : {}),
    tensions: extractTensions(snapshot, { maxPerKind: 5 }),
  }
}

/**
 * Component id = `<container>/src/<second>` for "src-like" structure,
 * else `<container>/<first>`.
 */
function deriveCompId(containerId: string, fileId: string): string {
  const rel = fileId.slice(containerId.length + 1)
  const parts = rel.split('/')
  if (parts[0] === 'src' && parts.length >= 3) {
    return `${containerId}/src/${parts[1]}`
  }
  return `${containerId}/${parts[0]}`
}

function groupFilesByComponent(containerId: string, cFiles: GraphNode[]): Map<string, GraphNode[]> {
  const byComp = new Map<string, GraphNode[]>()
  for (const f of cFiles) {
    const compId = deriveCompId(containerId, f.id)
    const arr = byComp.get(compId) || []
    arr.push(f)
    byComp.set(compId, arr)
  }
  return byComp
}

function computeComponentEdgeDegrees(idSet: Set<string>, edges: GraphEdge[]): { inD: number; outD: number } {
  let inD = 0
  let outD = 0
  for (const e of edges) {
    const inInSet = idSet.has(e.to)
    const outInSet = idSet.has(e.from)
    if (inInSet && !outInSet) inD++
    if (outInSet && !inInSet) outD++
  }
  return { inD, outD }
}

function buildComponentTopFiles(
  nodes: GraphNode[],
  inDeg: Map<string, number>,
  adrMarkers?: Map<string, string[]>,
): Array<{ id: string; label: string; inDegree: number; adrs?: string[] }> {
  return nodes
    .map(n => {
      const t = { id: n.id, label: n.label, inDegree: inDeg.get(n.id) || 0 } as { id: string; label: string; inDegree: number; adrs?: string[] }
      const adrs = adrMarkers?.get(n.id)
      if (adrs) t.adrs = adrs
      return t
    })
    .filter(t => t.inDegree > 0)
    .sort((a, b) => b.inDegree - a.inDegree || a.id.localeCompare(b.id))
    .slice(0, 3)
}

function dominantTags(nodes: GraphNode[]): string[] {
  const tagCounts = new Map<string, number>()
  for (const n of nodes) {
    for (const t of n.tags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1)
  }
  return Array.from(tagCounts.entries())
    .filter(([_, c]) => c >= Math.max(1, nodes.length / 2))
    .map(([t]) => t)
    .sort()
}

function unionAdrs(nodes: GraphNode[], adrMarkers?: Map<string, string[]>): string[] | undefined {
  if (!adrMarkers) return undefined
  const set = new Set<string>()
  for (const n of nodes) {
    const arr = adrMarkers.get(n.id)
    if (arr) for (const a of arr) set.add(a)
  }
  return set.size > 0 ? [...set].sort() : undefined
}

function buildComponents(
  containerId: string,
  cFiles: GraphNode[],
  edges: GraphEdge[],
  inDeg: Map<string, number>,
  outDeg: Map<string, number>,
  adrMarkers?: Map<string, string[]>,
): ComponentEntry[] {
  const byComp = groupFilesByComponent(containerId, cFiles)
  const compIdToLabel = (cid: string): string => cid.slice(containerId.length + 1).split('/').slice(-1)[0]

  const entries: ComponentEntry[] = Array.from(byComp.entries()).map(([cid, nodes]) => {
    const idSet = new Set(nodes.map(n => n.id))
    const { inD, outD } = computeComponentEdgeDegrees(idSet, edges)
    const compAdrs = unionAdrs(nodes, adrMarkers)
    return {
      id: cid,
      label: compIdToLabel(cid),
      fileCount: nodes.length,
      inDegree: inD,
      outDegree: outD,
      topFiles: buildComponentTopFiles(nodes, inDeg, adrMarkers),
      tags: dominantTags(nodes),
      ...(compAdrs ? { adrs: compAdrs } : {}),
    }
  })

  entries.sort((a, b) => b.fileCount - a.fileCount || a.label.localeCompare(b.label))
  return entries
}

// ─── Render: Level 1 ─────────────────────────────────────────────────────────

export function renderLevel1(s: SynopsisJSON): string {
  const lines: string[] = []
  lines.push(`# CodeGraph Synopsis — Level 1 (Context)`)
  lines.push('')
  lines.push(`_Generated ${s.generatedAt}${s.commitHash ? ` · commit ${s.commitHash}` : ''}_`)
  lines.push('')
  lines.push(`**Stats** — ${s.stats.totalFiles} files · ${s.stats.totalEdges} edges · ${s.stats.orphanCount} orphans · health ${formatHealth(s.stats.healthScore)}`)
  lines.push('')
  lines.push(`**Edges** — ${formatEdgeBreakdown(s.edgesByType)}`)
  lines.push('')

  // Phase 3.8 signaux — une ligne chacun si présent.
  if (s.phase38) {
    const p = s.phase38
    const sig: string[] = []
    if (p.packageDeps) sig.push(`**Deps** — ${p.packageDeps.missing} missing · ${p.packageDeps.declaredUnused} unused · ${p.packageDeps.devOnly} devOnly`)
    if (p.barrels) sig.push(`**Barrels** — ${p.barrels.total} total · ${p.barrels.lowValue} low-value`)
    if (p.taint) sig.push(`**Taint** — ${p.taint.total} violations (crit ${p.taint.critical} · high ${p.taint.high} · med ${p.taint.medium} · low ${p.taint.low})`)
    if (p.dsm) sig.push(`**DSM** — ${p.dsm.containers} containers · ${p.dsm.backEdges} back-edges · ${p.dsm.sccSizeGt1} SCC(s) ≥ 2`)
    for (const line of sig) {
      lines.push(line)
      lines.push('')
    }
  }

  // Containers
  lines.push(`## Containers`)
  lines.push('')
  for (const c of s.containers) {
    const compTop = c.components.slice(0, 5).map(x => `\`${x.label}\`(${x.fileCount})`).join(' · ')
    lines.push(`- **${c.id}** — ${c.fileCount} files · ${c.components.length} components · ${c.orphanCount} orphan  →  ${compTop}`)
  }
  lines.push('')

  // Top hubs (avec ADRs gouvernant si fournis)
  lines.push(`## Top hubs (in-degree, global)`)
  lines.push('')
  for (const h of s.topHubs) {
    const adrSuffix = h.adrs && h.adrs.length > 0
      ? ` · gov by ${h.adrs.map(n => `ADR-${n}`).join(', ')}`
      : ''
    lines.push(`- **${h.inDegree}** \`${h.id}\`${adrSuffix}`)
  }
  lines.push('')

  // ADR anchor suggestions (Lien 1+2) — fichiers load-bearing sans marqueur.
  // Section présente seulement si options.adrMarkers a été fourni à buildSynopsis.
  if (s.adrSuggestions && s.adrSuggestions.length > 0) {
    lines.push(`## ⚠ ADR anchor suggestions`)
    lines.push('')
    lines.push(`Fichiers load-bearing (in-degree ≥ seuil ou truth-point) sans aucun marqueur \`// ADR-NNN\` dans le code. Intentionnel ? Sinon, poser un marqueur ou créer un ADR.`)
    lines.push('')
    for (const sug of s.adrSuggestions.slice(0, 10)) {
      lines.push(`- **${sug.inDegree}** \`${sug.file}\` _(${sug.reason})_`)
    }
    lines.push('')
  }

  // Cross-container edges
  if (s.crossContainerEdges.length) {
    lines.push(`## Cross-container flow`)
    lines.push('')
    for (const x of s.crossContainerEdges) {
      const sample = x.samples.length ? `  _e.g._ ${x.samples.map(v => `\`${v}\``).join(', ')}` : ''
      lines.push(`- ${x.from} → ${x.to} · ${x.count} \`${x.type}\`${sample}`)
    }
    lines.push('')
  }

  // Mermaid
  lines.push(`## Map`)
  lines.push('')
  lines.push('```mermaid')
  lines.push('graph TB')
  for (const c of s.containers) {
    const safe = mermaidId(c.id)
    lines.push(`  ${safe}["${c.label}<br/>${c.fileCount} files"]`)
  }
  for (const x of s.crossContainerEdges) {
    lines.push(`  ${mermaidId(x.from)} -->|${x.count} ${x.type}| ${mermaidId(x.to)}`)
  }
  lines.push('```')
  lines.push('')
  return lines.join('\n')
}

// ─── Render: Level 2 ─────────────────────────────────────────────────────────

export function renderLevel2(s: SynopsisJSON): string {
  const lines: string[] = []
  lines.push(`# CodeGraph Synopsis — Level 2 (Containers)`)
  lines.push('')
  lines.push(`_Generated ${s.generatedAt}${s.commitHash ? ` · commit ${s.commitHash}` : ''}_`)
  lines.push('')

  for (const c of s.containers) {
    lines.push(`## ${c.id}`)
    lines.push('')
    lines.push(`${c.fileCount} files · ${c.components.length} components · ${c.orphanCount} orphans · ${c.entryPoints.length} entry points`)
    lines.push('')
    lines.push(`### Components`)
    lines.push('')
    for (const comp of c.components.slice(0, 10)) {
      const tagStr = comp.tags.length ? ` [${comp.tags.join(',')}]` : ''
      lines.push(`- \`${comp.label}\` — ${comp.fileCount} files · in ${comp.inDegree} · out ${comp.outDegree}${tagStr}`)
    }
    if (c.components.length > 10) {
      lines.push(`- _…${c.components.length - 10} more_`)
    }
    lines.push('')

    if (c.topHubs.length) {
      lines.push(`### Top files (in-degree)`)
      lines.push('')
      for (const h of c.topHubs) {
        lines.push(`- **${h.inDegree}** \`${h.id}\``)
      }
      lines.push('')
    }

    // Events with emitter → listener mapping (denser than two flat lists)
    if (c.events.mappings.length) {
      lines.push(`### Events`)
      lines.push('')
      for (const m of c.events.mappings) {
        const em = m.emitters.length ? m.emitters.map(x => `\`${x}\``).join(', ') : '_external_'
        const lst = m.listeners.length ? m.listeners.map(x => `\`${x}\``).join(', ') : '_none_'
        lines.push(`- **${m.label}** — emits: ${em} → listens: ${lst}`)
      }
      lines.push('')
    }

    const summary: string[] = []
    if (c.routes.length) summary.push(`${c.routes.length} routes exposed`)
    if (c.tables.length) summary.push(`${c.tables.length} db tables touched`)
    if (summary.length) {
      lines.push(`### Surface`)
      lines.push('')
      lines.push(summary.join(' · '))
      lines.push('')
      if (c.routes.length) {
        lines.push(`- **Routes:** ${truncateList(c.routes, 15)}`)
      }
      if (c.tables.length) {
        lines.push(`- **Tables:** ${truncateList(c.tables, 20)}`)
      }
      lines.push('')
    }
  }

  // Mermaid: containers w/ components (top 5 per container) + cross-container edges
  lines.push(`## Map`)
  lines.push('')
  lines.push('```mermaid')
  lines.push('graph TB')
  for (const c of s.containers) {
    lines.push(`  subgraph ${mermaidId(c.id)} [${c.label}]`)
    for (const comp of c.components.slice(0, 6)) {
      lines.push(`    ${mermaidId(comp.id)}["${comp.label}<br/>${comp.fileCount}"]`)
    }
    lines.push(`  end`)
  }
  for (const x of s.crossContainerEdges) {
    lines.push(`  ${mermaidId(x.from)} -->|${x.count} ${x.type}| ${mermaidId(x.to)}`)
  }
  lines.push('```')
  lines.push('')
  return lines.join('\n')
}

// ─── Render: Level 3 ─────────────────────────────────────────────────────────

export function renderLevel3(s: SynopsisJSON, containerId: string): string {
  const c = s.containers.find(x => x.id === containerId)
  if (!c) {
    const avail = s.containers.map(x => x.id).join(', ')
    return `# CodeGraph Synopsis — Level 3 (unknown container "${containerId}")\n\nAvailable: ${avail}\n`
  }

  const lines: string[] = []
  lines.push(`# CodeGraph Synopsis — Level 3 (Components — ${c.id})`)
  lines.push('')
  lines.push(`_Generated ${s.generatedAt}${s.commitHash ? ` · commit ${s.commitHash}` : ''}_`)
  lines.push('')
  lines.push(`${c.fileCount} files · ${c.components.length} components · ${c.orphanCount} orphans`)
  lines.push('')

  if (c.entryPoints.length) {
    lines.push(`## Entry points`)
    lines.push('')
    for (const e of c.entryPoints) {
      lines.push(`- \`${e}\``)
    }
    lines.push('')
  }

  lines.push(`## Components`)
  lines.push('')
  for (const comp of c.components) {
    const tagStr = comp.tags.length ? ` [${comp.tags.join(',')}]` : ''
    lines.push(`### \`${comp.label}\`${tagStr} · ${comp.fileCount} files`)
    lines.push('')
    lines.push(`in: ${comp.inDegree} · out: ${comp.outDegree}`)
    if (comp.topFiles.length) {
      lines.push('')
      lines.push(`Key files:`)
      for (const f of comp.topFiles) {
        lines.push(`- \`${f.label}\` (in ${f.inDegree}) — \`${f.id}\``)
      }
    }
    lines.push('')
  }

  if (c.events.mappings.length) {
    lines.push(`## Events`)
    lines.push('')
    for (const m of c.events.mappings) {
      const em = m.emitters.length ? m.emitters.map(x => `\`${x}\``).join(', ') : '_external_'
      const lst = m.listeners.length ? m.listeners.map(x => `\`${x}\``).join(', ') : '_none_'
      lines.push(`- **${m.label}** — emits: ${em} → listens: ${lst}`)
    }
    lines.push('')
  }

  if (c.routes.length) {
    lines.push(`## Routes exposed`)
    lines.push('')
    lines.push(truncateList(c.routes, 20))
    lines.push('')
  }

  if (c.tables.length) {
    lines.push(`## DB tables touched`)
    lines.push('')
    lines.push(truncateList(c.tables, 30))
    lines.push('')
  }

  // Mermaid: inter-component edges inside this container
  lines.push(`## Map`)
  lines.push('')
  lines.push('```mermaid')
  lines.push('flowchart LR')
  for (const comp of c.components) {
    lines.push(`  ${mermaidId(comp.id)}["${comp.label}<br/>${comp.fileCount}"]`)
  }
  // This rendering stays at component granularity; we do not include every import.
  // We summarise: each pair (compA, compB) with count.
  // Rebuild from topFiles would be insufficient; we rely on caller input only.
  // For MVP: no internal edges in the Level 3 map — only component boxes.
  // Rationale: intra-container edges count in the hundreds (imports); the node
  // boxes + key-files list already answer 8/10 questions without drawing edges.
  lines.push('```')
  lines.push('')
  return lines.join('\n')
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatEdgeBreakdown(ebt: Partial<Record<EdgeType, number>>): string {
  const order: EdgeType[] = ['import', 'event', 'route', 'queue', 'dynamic-load', 'db-table']
  return order
    .filter(t => (ebt[t] || 0) > 0)
    .map(t => `${ebt[t]} ${t}`)
    .join(' · ')
}

function formatHealth(score: number): string {
  return `${Math.round(score * 100)}%`
}

function truncateList(items: string[], max: number): string {
  if (items.length <= max) return items.map(i => `\`${i}\``).join(', ')
  return items.slice(0, max).map(i => `\`${i}\``).join(', ') + ` _(+${items.length - max} more)_`
}

function mermaidId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, '_')
}

// ─── Size estimation (for tests) ─────────────────────────────────────────────

/**
 * Rough token count — word count × 1.3. Matches the OpenAI heuristic used
 * elsewhere; exact enough for compactness invariants (Level 1 ≤ 500, etc.).
 */
export function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length
  return Math.round(words * 1.3)
}
