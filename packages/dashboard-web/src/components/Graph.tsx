import { createEffect, onCleanup, onMount } from 'solid-js'
import Sigma from 'sigma'
import Graph from 'graphology'
import { forceAtlas2 } from 'graphology-layout-forceatlas2'
import type { SnapshotPayload, Tension } from '../lib/api.js'
import { store } from '../store.js'

const TENSION_COLORS: Record<string, string> = {
  cycle: '#ef4444',
  orphan: '#71717a',
  'barrel-low': '#a855f7',
  'long-fn': '#f59e0b',
  drift: '#3b82f6',
}

function colorForNode(kind: string | undefined, type: string | undefined): string {
  if (kind && TENSION_COLORS[kind]) return TENSION_COLORS[kind]
  return type === 'directory' ? '#3f3f46' : '#10b981'
}

function buildTensionMap(tensions: Tension[] | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (!tensions) return out
  for (const tn of tensions) {
    if (!out.has(tn.target)) out.set(tn.target, tn.kind)
  }
  return out
}

function addNodes(g: Graph, snap: SnapshotPayload, tensionMap: Map<string, string>): void {
  for (const node of snap.data.nodes) {
    g.addNode(node.id, {
      label: node.label ?? node.id.split('/').pop() ?? node.id,
      size: node.type === 'directory' ? 6 : 3,
      color: colorForNode(tensionMap.get(node.id), node.type),
      x: Math.random(),
      y: Math.random(),
    })
  }
}

function addEdges(g: Graph, snap: SnapshotPayload): void {
  for (const e of snap.data.edges) {
    if (!g.hasNode(e.from) || !g.hasNode(e.to)) continue
    if (g.hasEdge(e.from, e.to)) continue
    g.addEdge(e.from, e.to, { color: '#27272a', size: 0.4 })
  }
}

function runLayout(g: Graph): void {
  forceAtlas2.assign(g, {
    iterations: 100,
    settings: { gravity: 1, scalingRatio: 8, slowDown: 4, adjustSizes: true },
  })
}

/**
 * Sigma host. Re-renders the graph when the snapshot resource updates.
 * Uses a cheap forceAtlas2 settle (no worker) — enough for ≤2k nodes.
 * For real monorepos (>5k) wire graphology-layout-forceatlas2/worker later.
 */
export function GraphView() {
  let host: HTMLDivElement | undefined
  let sigma: Sigma | null = null

  const buildGraph = (): Graph => {
    const g = new Graph({ multi: false, type: 'directed' })
    const snap = store.snapshot()
    if (!snap) return g
    const tensionMap = buildTensionMap(store.tensions()?.tensions)
    addNodes(g, snap, tensionMap)
    addEdges(g, snap)
    runLayout(g)
    return g
  }

  onMount(() => {
    if (!host) return
    sigma = new Sigma(new Graph(), host, {
      labelDensity: 0.07,
      labelGridCellSize: 60,
      labelRenderedSizeThreshold: 4,
      defaultEdgeColor: '#27272a',
      defaultNodeColor: '#10b981',
    })
    sigma.on('clickNode', ({ node }) => store.setFocusedNode(node))
    sigma.on('clickStage', () => store.setFocusedNode(null))
  })

  createEffect(() => {
    const snap = store.snapshot()
    if (!snap || !sigma) return
    const g = buildGraph()
    sigma.setGraph(g)
    sigma.refresh()
  })

  onCleanup(() => {
    sigma?.kill()
    sigma = null
  })

  return <div class="sigma-host w-full h-full" ref={host} />
}
