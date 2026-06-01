// ADR-032 — consumer du contrat HTTP via ./api.js (type SnapshotPayload).
// ADR-033 — scaling : ce renderer dépend de la taille de snapshot.json ;
// pre-Phase-2 chargeait le fat blob, post-Phase-2 lit graph core seul.
// Obsidian-style large-scale code graph renderer.
// Pan + zoom + LOD labels + active-edit ripple + bezier hooks→files arcs.
// Adapted from the Codegraph Cockpit design (cockpit-cosmos.js) for SolidJS,
// but feeds on real snapshot data from the dashboard-server API.

import type { SnapshotPayload } from './api.js'

export interface CosmosNode {
  id: number
  apiId: string
  path: string
  name: string
  dir: string
  pkg: string
  color: string
  kind: string
  loc: number
  hub: boolean
  hot: boolean
  active: boolean
  impacted: boolean
  x: number
  y: number
  vx: number
  vy: number
}

export interface CosmosEdge {
  s: number
  t: number
}

export interface CosmosDataset {
  nodes: CosmosNode[]
  edges: CosmosEdge[]
  byId: Map<number, CosmosNode>
  byApiId: Map<string, CosmosNode>
  byPath: Map<string, CosmosNode>
}

export interface CosmosMountOptions {
  canvas: HTMLCanvasElement
  dataset: CosmosDataset
  getHookPins?: () => Record<string, { x: number; y: number }>
  getHoveredStage?: () => string | null
  getStageImpacts?: () => Record<string, string[]>
  getTreeHoverId?: () => number | null
  getActiveFileApiId?: () => string | null
  onHoverNode?: (node: CosmosNode | null) => void
  onClickNode?: (node: CosmosNode) => void
}

export interface CosmosInstance {
  destroy: () => void
  frameAll: () => void
  zoomIn: () => void
  zoomOut: () => void
  setActiveFile: (apiId: string | null) => void
  refreshImpacted: () => void
  dataset: CosmosDataset
}

// Stable hash → 0..1 for deterministic colour from package name.
function hash01(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i)
  return ((h >>> 0) % 360) / 360
}

function colourFor(pkg: string): string {
  const hue = Math.floor(hash01(pkg) * 360)
  return `oklch(75% 0.14 ${hue})`
}

function classifyKind(name: string): string {
  if (name.endsWith('.tsx')) return 'tsx'
  if (name.includes('.test.') || name.endsWith('.spec.ts')) return 'test'
  if (name === 'index.ts' || name === 'index.tsx') return 'barrel'
  if (name.endsWith('.dl')) return 'dl'
  if (name.endsWith('.sql')) return 'sql'
  if (name.endsWith('.md')) return 'md'
  if (name.endsWith('.json') || name.endsWith('.yml') || name.endsWith('.yaml')) return 'config'
  return 'ts'
}

function splitPath(p: string): { pkg: string; dir: string; name: string } {
  const parts = p.split('/').filter(Boolean)
  const name = parts[parts.length - 1] ?? p
  // Heuristic: if path starts with packages/, pkg is the next segment.
  // Otherwise pkg is the first segment, dir is everything between.
  let pkg = parts[0] ?? '_root'
  let dirStart = 1
  if (pkg === 'packages' && parts.length > 1) {
    pkg = parts[1] ?? '_root'
    dirStart = 2
  }
  // Strip 'src/' if it directly follows the package name.
  if (parts[dirStart] === 'src') dirStart++
  const dirSegs = parts.slice(dirStart, parts.length - 1)
  const dir = dirSegs.join('/') || '.'
  return { pkg, dir, name }
}

export function buildDatasetFromSnapshot(snap: SnapshotPayload | undefined): CosmosDataset {
  const { nodes, byApiId, byPath } = buildCosmosNodes(snap?.data.nodes ?? [])
  const edges = buildCosmosEdges(snap?.data.edges ?? [], byApiId)
  markHubsByDegree(nodes, edges)
  layoutNodes(nodes, edges)

  const byId = new Map<number, CosmosNode>(nodes.map((n) => [n.id, n]))
  return { nodes, edges, byId, byApiId, byPath }
}

type ApiNodes = NonNullable<SnapshotPayload['data']>['nodes']
type ApiEdges = NonNullable<SnapshotPayload['data']>['edges']

/** Convertit les nodes API en CosmosNode + index byApiId/byPath. */
function buildCosmosNodes(apiNodes: ApiNodes): {
  nodes: CosmosNode[]
  byApiId: Map<string, CosmosNode>
  byPath: Map<string, CosmosNode>
} {
  const nodes: CosmosNode[] = []
  const byApiId = new Map<string, CosmosNode>()
  const byPath = new Map<string, CosmosNode>()
  let id = 0

  for (const n of apiNodes) {
    const path = n.label ?? n.id
    const { pkg, dir, name } = splitPath(path)
    const tags = n.tags ?? []
    const cosmosNode: CosmosNode = {
      id: id++,
      apiId: n.id,
      path,
      name,
      dir,
      pkg,
      color: colourFor(pkg),
      kind: classifyKind(name),
      loc: 50,
      hub: tags.includes('hub') || tags.includes('truth-point'),
      hot: false,
      active: false,
      impacted: false,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
    }
    nodes.push(cosmosNode)
    byApiId.set(n.id, cosmosNode)
    byPath.set(path, cosmosNode)
  }
  return { nodes, byApiId, byPath }
}

/** Convertit les edges API en CosmosEdge (drop from/to inconnu + self-loops). */
function buildCosmosEdges(apiEdges: ApiEdges, byApiId: Map<string, CosmosNode>): CosmosEdge[] {
  const edges: CosmosEdge[] = []
  for (const e of apiEdges) {
    const s = byApiId.get(e.from)
    const t = byApiId.get(e.to)
    if (s && t && s.id !== t.id) edges.push({ s: s.id, t: t.id })
  }
  return edges
}

/** Marque les hubs heuristiquement : top 4% par degré (min 1). */
function markHubsByDegree(nodes: CosmosNode[], edges: CosmosEdge[]): void {
  const degree = new Map<number, number>()
  for (const e of edges) {
    degree.set(e.s, (degree.get(e.s) ?? 0) + 1)
    degree.set(e.t, (degree.get(e.t) ?? 0) + 1)
  }
  const sorted = [...degree.entries()].sort((a, b) => b[1] - a[1])
  const hubCount = Math.max(1, Math.floor(nodes.length * 0.04))
  for (let i = 0; i < Math.min(hubCount, sorted.length); i++) {
    const [nid] = sorted[i]
    const n = nodes[nid]
    if (n) n.hub = true
  }
}

// Single-pass force-directed layout with grid bucketing.
// Deliberately bounded — this runs once at dataset build, never in the
// render loop, to avoid the O(n²) lag the original design hit.
const LAYOUT = {
  spring: 0.012,
  springLen: 90,
  repel: 1100,
  center: 0.0008,
  damp: 0.85,
  cell: 140,
} as const

type PkgCenter = Map<string, { x: number; y: number }>

function layoutNodes(nodes: CosmosNode[], edges: CosmosEdge[]): void {
  if (nodes.length === 0) return

  const pkgCenter = buildPkgCenters(nodes)
  seedPositions(nodes, pkgCenter)

  const iters = Math.min(220, 60 + nodes.length)
  for (let iter = 0; iter < iters; iter++) {
    const a = 1 - iter / iters
    const grid = buildSpatialGrid(nodes, LAYOUT.cell)
    applyRepulsion(nodes, grid, pkgCenter, a)
    applySprings(nodes, edges, a)
    integrate(nodes)
  }
}

/** Centre d'ancrage par package, réparti sur une ellipse. */
function buildPkgCenters(nodes: CosmosNode[]): PkgCenter {
  const pkgs = [...new Set(nodes.map((n) => n.pkg))]
  const pkgCenter: PkgCenter = new Map()
  pkgs.forEach((p, i) => {
    const a = (i / pkgs.length) * Math.PI * 2
    pkgCenter.set(p, { x: Math.cos(a) * 1100, y: Math.sin(a) * 800 })
  })
  return pkgCenter
}

/** Position initiale : autour du centre du package + jitter. */
function seedPositions(nodes: CosmosNode[], pkgCenter: PkgCenter): void {
  for (const n of nodes) {
    const c = pkgCenter.get(n.pkg) ?? { x: 0, y: 0 }
    n.x = c.x + (Math.random() - 0.5) * 280
    n.y = c.y + (Math.random() - 0.5) * 280
  }
}

/** Bucketing spatial : map "cx,cy" → nodes de la cellule. */
function buildSpatialGrid(nodes: CosmosNode[], cell: number): Map<string, CosmosNode[]> {
  const grid = new Map<string, CosmosNode[]>()
  for (const n of nodes) {
    const k = `${Math.floor(n.x / cell)},${Math.floor(n.y / cell)}`
    let arr = grid.get(k)
    if (!arr) {
      arr = []
      grid.set(k, arr)
    }
    arr.push(n)
  }
  return grid
}

/** Forces par node : répulsion voisins (grid 3×3) + attraction package + centre. */
function applyRepulsion(nodes: CosmosNode[], grid: Map<string, CosmosNode[]>, pkgCenter: PkgCenter, a: number): void {
  const cell = LAYOUT.cell
  for (const n of nodes) {
    const cx = Math.floor(n.x / cell)
    const cy = Math.floor(n.y / cell)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        repelAgainstCell(n, grid.get(`${cx + dx},${cy + dy}`), a)
      }
    }
    const c = pkgCenter.get(n.pkg) ?? { x: 0, y: 0 }
    n.vx += (c.x - n.x) * 0.02 * a
    n.vy += (c.y - n.y) * 0.02 * a
    n.vx += -n.x * LAYOUT.center * a
    n.vy += -n.y * LAYOUT.center * a
  }
}

/** Répulsion de `n` contre tous les nodes d'une cellule voisine. */
function repelAgainstCell(n: CosmosNode, cellNodes: CosmosNode[] | undefined, a: number): void {
  if (!cellNodes) return
  for (const m of cellNodes) {
    if (m.id === n.id) continue
    let ddx = n.x - m.x
    let ddy = n.y - m.y
    let d2 = ddx * ddx + ddy * ddy
    if (d2 < 0.1) {
      ddx = Math.random() - 0.5
      ddy = Math.random() - 0.5
      d2 = 0.1
    }
    const f = LAYOUT.repel / d2
    n.vx += ddx * f * a
    n.vy += ddy * f * a
  }
}

/** Forces de ressort le long des edges. */
function applySprings(nodes: CosmosNode[], edges: CosmosEdge[], a: number): void {
  for (const e of edges) {
    const s = nodes[e.s]
    const t = nodes[e.t]
    if (!s || !t) continue
    const dx = t.x - s.x
    const dy = t.y - s.y
    const d = Math.sqrt(dx * dx + dy * dy) || 1
    const f = (d - LAYOUT.springLen) * LAYOUT.spring
    s.vx += (dx / d) * f * a
    s.vy += (dy / d) * f * a
    t.vx -= (dx / d) * f * a
    t.vy -= (dy / d) * f * a
  }
}

/** Intégration Verlet amortie : applique vélocité, sanitize NaN, damp. */
function integrate(nodes: CosmosNode[]): void {
  for (const n of nodes) {
    if (!Number.isFinite(n.vx)) n.vx = 0
    if (!Number.isFinite(n.vy)) n.vy = 0
    n.x += n.vx
    n.y += n.vy
    n.vx *= LAYOUT.damp
    n.vy *= LAYOUT.damp
  }
}

// ─── Camera + viewport types ───────────────────────────────────────────────

interface Camera {
  x: number
  y: number
  zoom: number
  targetZoom: number
}

interface Viewport {
  wx0: number
  wx1: number
  wy0: number
  wy1: number
}

/** Pure : pas de side-effect. Convertit coordonnée monde → pixel écran. */
function worldToScreen(
  wx: number,
  wy: number,
  cam: Camera,
  w: number,
  h: number,
): { x: number; y: number } {
  return {
    x: (wx - cam.x) * cam.zoom + w / 2,
    y: (wy - cam.y) * cam.zoom + h / 2,
  }
}

/** Pure : calcule les bornes monde du viewport avec un padding pour le culling. */
function computeViewport(cam: Camera, w: number, h: number): Viewport {
  const padding = 200 / cam.zoom
  return {
    wx0: cam.x - w / (2 * cam.zoom) - padding,
    wx1: cam.x + w / (2 * cam.zoom) + padding,
    wy0: cam.y - h / (2 * cam.zoom) - padding,
    wy1: cam.y + h / (2 * cam.zoom) + padding,
  }
}

// ─── RenderContext partagé par les helpers de rendering ────────────────────
// Refactor 2026-05-11 (cyclo bomb cleanup) : `mountCosmos` faisait
// cyclo=106 cog=158, l'écrasante majorité venant de `tick()` qui
// dessinait 10 sections in-place. Extraction en helpers top-level (le
// visitor ts-morph les voit alors comme fonctions séparées, chacune
// comptée individuellement) — `mountCosmos` retrouve une complexité
// approchable et chaque helper est testable / lisible indépendamment.

interface RenderContext {
  ctx: CanvasRenderingContext2D
  dataset: CosmosDataset
  cam: Camera
  adj: Map<number, Set<number>>
  opts: CosmosMountOptions
  viewport: Viewport
  w: number
  h: number
  t: number
  z: number
}

// ─── Drawing helpers (un par responsabilité, ordre = pipeline tick) ─────────

function drawEdges(rc: RenderContext): void {
  const { ctx, dataset, viewport: vp, w, h, z, cam } = rc
  ctx.lineWidth = 0.4
  const edgeAlpha = z < 0.4 ? 0.04 : z < 0.8 ? 0.08 : 0.13
  ctx.strokeStyle = `rgba(180,210,235,${edgeAlpha})`
  ctx.beginPath()
  // LOD : skip 1/N edges en zoom-out pour préserver fps
  const drawEdge = z > 0.55 ? 1 : z > 0.3 ? 2 : 4
  for (let i = 0; i < dataset.edges.length; i += drawEdge) {
    const e = dataset.edges[i]
    const s = dataset.byId.get(e.s)
    const tt = dataset.byId.get(e.t)
    if (!s || !tt) continue
    if ((s.x < vp.wx0 && tt.x < vp.wx0) || (s.x > vp.wx1 && tt.x > vp.wx1)) continue
    if ((s.y < vp.wy0 && tt.y < vp.wy0) || (s.y > vp.wy1 && tt.y > vp.wy1)) continue
    const sp = worldToScreen(s.x, s.y, cam, w, h)
    const tp = worldToScreen(tt.x, tt.y, cam, w, h)
    ctx.moveTo(sp.x, sp.y)
    ctx.lineTo(tp.x, tp.y)
  }
  ctx.stroke()
}

function drawActiveFlow(rc: RenderContext): void {
  const { ctx, dataset, adj, cam, w, h, t } = rc
  const active = dataset.nodes.find((n) => n.active)
  if (!active) return
  const activeP = worldToScreen(active.x, active.y, cam, w, h)
  ctx.lineWidth = 1.2
  const dash = (t * 30) % 12
  ctx.setLineDash([4, 4])
  ctx.lineDashOffset = -dash
  ctx.strokeStyle = 'rgba(255,210,90,0.65)'
  const neighbours = adj.get(active.id)
  if (neighbours) {
    for (const id of neighbours) {
      const n = dataset.byId.get(id)
      if (!n) continue
      const np = worldToScreen(n.x, n.y, cam, w, h)
      ctx.beginPath()
      ctx.moveTo(activeP.x, activeP.y)
      ctx.lineTo(np.x, np.y)
      ctx.stroke()
    }
  }
  ctx.setLineDash([])
}

/** Retourne les ids dim-by-stage (pour le rendering des nodes). null si pas de hook hover. */
function drawHookStageArcs(rc: RenderContext): Set<number> | null {
  const { ctx, dataset, opts, cam, w, h, t } = rc
  const hoveredStage = opts.getHoveredStage?.() ?? null
  if (!hoveredStage) return null
  const pins = opts.getHookPins?.() ?? {}
  const pin = pins[hoveredStage]
  const impacts = opts.getStageImpacts?.()?.[hoveredStage] ?? []
  if (!pin || impacts.length === 0) return null

  const dimByStage = new Set<number>()
  ctx.strokeStyle = 'rgba(120,220,240,0.55)'
  ctx.lineWidth = 1.1
  ctx.setLineDash([3, 3])
  ctx.lineDashOffset = -((t * 18) % 6)
  for (const apiId of impacts) {
    const target = dataset.byApiId.get(apiId) ?? dataset.byPath.get(apiId)
    if (!target) continue
    dimByStage.add(target.id)
    const tp = worldToScreen(target.x, target.y, cam, w, h)
    const cx = (pin.x + tp.x) / 2 - 80
    ctx.beginPath()
    ctx.moveTo(pin.x, pin.y)
    ctx.bezierCurveTo(cx, pin.y, cx, tp.y, tp.x, tp.y)
    ctx.stroke()
  }
  ctx.setLineDash([])
  ctx.strokeStyle = 'rgba(120,220,240,0.85)'
  ctx.lineWidth = 1.5
  for (const id of dimByStage) {
    const target = dataset.byId.get(id)
    if (!target) continue
    const tp = worldToScreen(target.x, target.y, cam, w, h)
    ctx.beginPath()
    ctx.arc(tp.x, tp.y, 6, 0, Math.PI * 2)
    ctx.stroke()
  }
  return dimByStage
}

function drawTreeHoverHalo(rc: RenderContext): void {
  const { ctx, dataset, opts, cam, w, h, t } = rc
  const treeHoverId = opts.getTreeHoverId?.() ?? null
  if (treeHoverId == null) return
  const target = dataset.byId.get(treeHoverId)
  if (!target) return
  const tp = worldToScreen(target.x, target.y, cam, w, h)
  const pulse = (Math.sin(t * 4) + 1) / 2
  ctx.strokeStyle = `rgba(255,255,255,${0.5 + pulse * 0.4})`
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.arc(tp.x, tp.y, 12 + pulse * 4, 0, Math.PI * 2)
  ctx.stroke()
  ctx.strokeStyle = `rgba(255,255,255,${0.2 + pulse * 0.2})`
  ctx.beginPath()
  ctx.arc(tp.x, tp.y, 24 + pulse * 6, 0, Math.PI * 2)
  ctx.stroke()
}

function drawNodes(
  rc: RenderContext,
  dimByStage: Set<number> | null,
  hoverNode: CosmosNode | null,
): void {
  const { ctx, dataset, viewport: vp, cam, w, h, z, t } = rc
  const baseR = z < 0.35 ? 1.4 : z < 0.7 ? 1.9 : 2.4
  const showLabels = z > 0.85
  const showAllLabels = z > 1.6
  for (const n of dataset.nodes) {
    if (n.x < vp.wx0 || n.x > vp.wx1 || n.y < vp.wy0 || n.y > vp.wy1) continue
    const p = worldToScreen(n.x, n.y, cam, w, h)
    let r = baseR + (n.hub ? 1.6 : 0) + (n.hot ? 0.6 : 0)
    if (n.active) r = Math.max(r, 5)
    if (n.kind === 'barrel') r = Math.max(r * 0.65, 1.2)

    const dimmed = dimByStage && !dimByStage.has(n.id) && !n.active
    ctx.globalAlpha = dimmed ? 0.18 : 1
    ctx.fillStyle = n.color
    drawNodeShape(ctx, n, p, r)
    drawNodeOverlays(ctx, n, p, r, t)
    ctx.globalAlpha = 1
    drawNodeLabel(ctx, n, p, r, hoverNode, showLabels, showAllLabels)
  }
}

function drawNodeShape(
  ctx: CanvasRenderingContext2D,
  n: CosmosNode,
  p: { x: number; y: number },
  r: number,
): void {
  if (n.kind === 'barrel') {
    ctx.beginPath()
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
    ctx.strokeStyle = n.color
    ctx.lineWidth = 1
    ctx.stroke()
  } else {
    ctx.beginPath()
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
    ctx.fill()
  }
}

function drawNodeOverlays(
  ctx: CanvasRenderingContext2D,
  n: CosmosNode,
  p: { x: number; y: number },
  r: number,
  t: number,
): void {
  if (n.hub) {
    ctx.strokeStyle = 'rgba(255,255,255,0.45)'
    ctx.lineWidth = 0.7
    ctx.beginPath()
    ctx.arc(p.x, p.y, r + 1.2, 0, Math.PI * 2)
    ctx.stroke()
  }
  if (n.hot && !n.active) {
    const pulse = (Math.sin(t * 2 + n.id) + 1) / 2
    ctx.strokeStyle = `rgba(255,210,90,${0.15 + pulse * 0.2})`
    ctx.lineWidth = 0.8
    ctx.beginPath()
    ctx.arc(p.x, p.y, r + 2.5 + pulse * 1.5, 0, Math.PI * 2)
    ctx.stroke()
  }
  if (n.impacted) {
    ctx.strokeStyle = 'rgba(255,210,90,0.7)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(p.x, p.y, r + 2.5, 0, Math.PI * 2)
    ctx.stroke()
  }
  if (n.active) {
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
    ctx.fill()
    for (let i = 0; i < 3; i++) {
      const tt = ((t + i * 0.4) % 1.2) / 1.2
      ctx.strokeStyle = `rgba(255,255,255,${(1 - tt) * 0.5})`
      ctx.lineWidth = 1.2
      ctx.beginPath()
      ctx.arc(p.x, p.y, r + tt * 24, 0, Math.PI * 2)
      ctx.stroke()
    }
  }
}

function drawNodeLabel(
  ctx: CanvasRenderingContext2D,
  n: CosmosNode,
  p: { x: number; y: number },
  r: number,
  hoverNode: CosmosNode | null,
  showLabels: boolean,
  showAllLabels: boolean,
): void {
  const showLabel = showAllLabels
    || (showLabels && (n.hub || n.active || n.impacted || n.hot))
    || (hoverNode != null && hoverNode.id === n.id)
  if (!showLabel) return
  ctx.fillStyle = n.active
    ? '#ffffff'
    : n.impacted ? 'rgba(255,210,90,0.95)' : 'rgba(220,235,245,0.85)'
  ctx.font = `${n.active ? 600 : 500} ${n.active ? 11 : 10}px JetBrains Mono, ui-monospace, monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillText(n.name, p.x, p.y + r + 2)
}

function drawHoverTooltip(rc: RenderContext, hoverNode: CosmosNode | null): void {
  if (!hoverNode) return
  const { ctx, cam, w, h } = rc
  const n = hoverNode
  const p = worldToScreen(n.x, n.y, cam, w, h)
  const lines = [
    n.name,
    `${n.pkg} · ${n.dir}`,
    `${n.loc} LOC${n.hub ? ' · hub' : ''}${n.hot ? ' · hot' : ''}`,
  ]
  const W = 200
  const H = 52
  const tx = Math.min(p.x + 12, w - W - 8)
  const ty = Math.min(p.y + 12, h - H - 8)
  ctx.fillStyle = 'rgba(15,15,20,0.92)'
  ctx.strokeStyle = 'rgba(120,200,220,0.45)'
  ctx.lineWidth = 1
  ctx.fillRect(tx, ty, W, H)
  ctx.strokeRect(tx + 0.5, ty + 0.5, W - 1, H - 1)
  ctx.fillStyle = '#e2e8f0'
  ctx.font = '600 11px JetBrains Mono, monospace'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillText(lines[0], tx + 8, ty + 7)
  ctx.fillStyle = 'rgba(180,200,220,0.75)'
  ctx.font = '10px JetBrains Mono, monospace'
  ctx.fillText(lines[1], tx + 8, ty + 22)
  ctx.fillStyle = 'rgba(140,180,200,0.7)'
  ctx.fillText(lines[2], tx + 8, ty + 36)
}

/**
 * Resize le canvas pour le DPR courant + retourne le 2D context prêt à
 * dessiner. Retourne null si le ctx n'est pas dispo (= retry frame).
 */
function prepareCanvasContext(
  canvas: HTMLCanvasElement,
  w: number,
  h: number,
): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1
  if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
    canvas.width = Math.floor(w * dpr)
    canvas.height = Math.floor(h * dpr)
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  return ctx
}

// ─── mountCosmos ────────────────────────────────────────────────────────────

export function mountCosmos(opts: CosmosMountOptions): CosmosInstance {
  const { canvas, dataset } = opts

  const adj = new Map<number, Set<number>>()
  for (const e of dataset.edges) {
    if (!adj.has(e.s)) adj.set(e.s, new Set())
    if (!adj.has(e.t)) adj.set(e.t, new Set())
    adj.get(e.s)!.add(e.t)
    adj.get(e.t)!.add(e.s)
  }

  let activeApiId: string | null = opts.getActiveFileApiId?.() ?? null

  function applyActive(): void {
    for (const n of dataset.nodes) {
      n.active = false
      n.impacted = false
    }
    if (!activeApiId) return
    const a = dataset.byApiId.get(activeApiId)
    if (!a) return
    a.active = true
    a.hot = true
    const neighbours = adj.get(a.id)
    if (neighbours) for (const id of neighbours) {
      const n = dataset.byId.get(id)
      if (n) n.impacted = true
    }
  }
  applyActive()

  const cam: Camera = { x: 0, y: 0, zoom: 0.5, targetZoom: 0.5 }
  const drag = { active: false, lastX: 0, lastY: 0 }
  let hoverNode: CosmosNode | null = null

  function frameAll(): void {
    if (dataset.nodes.length === 0) return
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const n of dataset.nodes) {
      if (n.x < minX) minX = n.x
      if (n.x > maxX) maxX = n.x
      if (n.y < minY) minY = n.y
      if (n.y > maxY) maxY = n.y
    }
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    const dw = maxX - minX
    const dh = maxY - minY
    const w = canvas.clientWidth || 800
    const h = canvas.clientHeight || 600
    const z = Math.min(w / (dw + 200), h / (dh + 200))
    cam.x = cx
    cam.y = cy
    cam.zoom = Number.isFinite(z) ? z : 0.5
    cam.targetZoom = cam.zoom
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault()
    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const oldZ = cam.zoom
    const factor = Math.exp(-e.deltaY * 0.001)
    const newZ = Math.max(0.05, Math.min(5, cam.zoom * factor))
    const cx = canvas.clientWidth / 2
    const cy = canvas.clientHeight / 2
    const wxOld = (mx - cx) / oldZ + cam.x
    const wyOld = (my - cy) / oldZ + cam.y
    cam.x = wxOld - (mx - cx) / newZ
    cam.y = wyOld - (my - cy) / newZ
    cam.zoom = newZ
    cam.targetZoom = newZ
  }

  function onMouseDown(e: MouseEvent): void {
    drag.active = true
    drag.lastX = e.clientX
    drag.lastY = e.clientY
    canvas.style.cursor = 'grabbing'
  }

  function onMouseUp(): void {
    drag.active = false
    canvas.style.cursor = 'grab'
  }

  function onMouseMove(e: MouseEvent): void {
    if (drag.active) {
      cam.x -= (e.clientX - drag.lastX) / cam.zoom
      cam.y -= (e.clientY - drag.lastY) / cam.zoom
      drag.lastX = e.clientX
      drag.lastY = e.clientY
      return
    }
    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    if (mx < 0 || my < 0 || mx >= rect.width || my >= rect.height) return
    const wx = (mx - rect.width / 2) / cam.zoom + cam.x
    const wy = (my - rect.height / 2) / cam.zoom + cam.y
    let hit: CosmosNode | null = null
    let bestD = 14 / cam.zoom
    for (const n of dataset.nodes) {
      const d = Math.hypot(n.x - wx, n.y - wy)
      if (d < bestD) {
        bestD = d
        hit = n
      }
    }
    if (hit !== hoverNode) {
      hoverNode = hit
      opts.onHoverNode?.(hit)
    }
  }

  function onClick(): void {
    if (hoverNode && opts.onClickNode) opts.onClickNode(hoverNode)
  }

  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('mousedown', onMouseDown)
  window.addEventListener('mouseup', onMouseUp)
  window.addEventListener('mousemove', onMouseMove)
  canvas.addEventListener('click', onClick)

  let raf = 0

  // ADR-029 — refactor cyclo bomb : `tick()` était cyclo=106 cog=158
  // (10 sections de rendering in-place). Maintenant orchestrateur court
  // qui délègue aux helpers top-level (drawEdges, drawNodes, etc.).
  function tick(): void {
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (w < 4 || h < 4) {
      raf = requestAnimationFrame(tick)
      return
    }
    const ctx = prepareCanvasContext(canvas, w, h)
    if (!ctx) {
      raf = requestAnimationFrame(tick)
      return
    }
    cam.zoom += (cam.targetZoom - cam.zoom) * 0.15

    const rc: RenderContext = {
      ctx,
      dataset,
      cam,
      adj,
      opts,
      viewport: computeViewport(cam, w, h),
      w,
      h,
      t: performance.now() / 1000,
      z: cam.zoom,
    }

    drawEdges(rc)
    drawActiveFlow(rc)
    const dimByStage = drawHookStageArcs(rc)
    drawTreeHoverHalo(rc)
    drawNodes(rc, dimByStage, hoverNode)
    drawHoverTooltip(rc, hoverNode)

    raf = requestAnimationFrame(tick)
  }

  function start(): void {
    if (canvas.clientWidth > 50) {
      frameAll()
      cam.zoom *= 0.85
      cam.targetZoom = cam.zoom
      tick()
    } else {
      raf = requestAnimationFrame(start)
    }
  }
  start()

  return {
    destroy() {
      cancelAnimationFrame(raf)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('mousemove', onMouseMove)
      canvas.removeEventListener('click', onClick)
    },
    frameAll,
    zoomIn() {
      cam.targetZoom = Math.min(5, cam.targetZoom * 1.25)
    },
    zoomOut() {
      cam.targetZoom = Math.max(0.05, cam.targetZoom / 1.25)
    },
    setActiveFile(apiId) {
      activeApiId = apiId
      applyActive()
    },
    refreshImpacted() {
      applyActive()
    },
    dataset,
  }
}
