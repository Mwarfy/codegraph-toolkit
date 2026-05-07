import { createEffect, onCleanup, onMount } from 'solid-js'
import Sigma from 'sigma'
import Graph from 'graphology'
import { forceAtlas2 } from 'graphology-layout-forceatlas2'
import { store } from '../store.js'

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

    const tensionsByTarget = new Map<string, string>()
    const t = store.tensions()
    if (t) {
      for (const tn of t.tensions) {
        if (!tensionsByTarget.has(tn.target)) tensionsByTarget.set(tn.target, tn.kind)
      }
    }

    for (const node of snap.data.nodes) {
      const kind = tensionsByTarget.get(node.id)
      const color =
        kind === 'cycle'
          ? '#ef4444'
          : kind === 'orphan'
            ? '#71717a'
            : kind === 'barrel-low'
              ? '#a855f7'
              : kind === 'long-fn'
                ? '#f59e0b'
                : node.type === 'directory'
                  ? '#3f3f46'
                  : '#10b981'
      g.addNode(node.id, {
        label: node.label ?? node.id.split('/').pop() ?? node.id,
        size: node.type === 'directory' ? 6 : 3,
        color,
        x: Math.random(),
        y: Math.random(),
      })
    }
    for (const e of snap.data.edges) {
      if (!g.hasNode(e.from) || !g.hasNode(e.to)) continue
      if (g.hasEdge(e.from, e.to)) continue
      g.addEdge(e.from, e.to, { color: '#27272a', size: 0.4 })
    }

    forceAtlas2.assign(g, {
      iterations: 100,
      settings: {
        gravity: 1,
        scalingRatio: 8,
        slowDown: 4,
        adjustSizes: true,
      },
    })
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
