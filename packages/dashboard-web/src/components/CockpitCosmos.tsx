import { Show, createEffect, createMemo, onCleanup, onMount } from 'solid-js'
import { mountCosmos, type CosmosDataset, type CosmosInstance, type CosmosNode } from '../lib/cosmos.js'
import type { StagePins } from './CockpitPipeline.js'

interface CockpitCosmosProps {
  dataset: CosmosDataset
  activeApiId: string | null
  hoveredStage: () => string | null
  pins: () => StagePins
  stageImpacts: () => Record<string, string[]>
  treeHoverId: () => number | null
  setHoverNode: (n: CosmosNode | null) => void
  onClickNode: (n: CosmosNode) => void
  setHostRect: (rect: DOMRect | null) => void
}

export function CockpitCosmos(props: CockpitCosmosProps) {
  let canvas: HTMLCanvasElement | undefined
  let host: HTMLDivElement | undefined
  let inst: CosmosInstance | undefined

  function syncHostRect(): void {
    if (!host) {
      props.setHostRect(null)
      return
    }
    props.setHostRect(host.getBoundingClientRect())
  }

  onMount(() => {
    if (!canvas) return
    inst = mountCosmos({
      canvas,
      dataset: props.dataset,
      getHookPins: () => props.pins(),
      getHoveredStage: () => props.hoveredStage(),
      getStageImpacts: () => props.stageImpacts(),
      getTreeHoverId: () => props.treeHoverId(),
      getActiveFileApiId: () => props.activeApiId,
      onHoverNode: props.setHoverNode,
      onClickNode: props.onClickNode,
    })

    syncHostRect()
    const obs = new ResizeObserver(syncHostRect)
    if (host) obs.observe(host)
    window.addEventListener('resize', syncHostRect)
    window.addEventListener('scroll', syncHostRect, true)
    const tick = window.setInterval(syncHostRect, 500)
    onCleanup(() => {
      obs.disconnect()
      window.removeEventListener('resize', syncHostRect)
      window.removeEventListener('scroll', syncHostRect, true)
      clearInterval(tick)
    })
  })

  createEffect(() => {
    inst?.setActiveFile(props.activeApiId)
  })

  onCleanup(() => inst?.destroy())

  const stats = createMemo(() => ({
    files: props.dataset.nodes.length,
    edges: props.dataset.edges.length,
  }))

  return (
    <div
      ref={host}
      class="relative w-full h-full overflow-hidden"
      style={{ background: 'var(--bg-0)' }}
    >
      <canvas
        ref={canvas}
        class="block w-full h-full"
        style={{ cursor: 'grab' }}
      />

      {/* Top-left: title chip */}
      <div
        class="mono absolute uppercase flex items-center gap-2.5"
        style={{
          top: '12px',
          left: '12px',
          'font-size': '10px',
          color: 'var(--fg-2)',
          'letter-spacing': '0.06em',
          padding: '5px 10px',
          background: 'rgba(15,15,20,0.78)',
          border: '1px solid var(--bg-line)',
          'border-radius': '3px',
          'backdrop-filter': 'blur(6px)',
        }}
      >
        <span>cosmos · zoomable</span>
        <span style={{ color: 'var(--fg-3)' }}>
          {stats().files} files · {stats().edges} edges
        </span>
        <span style={{ color: 'var(--fg-3)' }}>· wheel = zoom · drag = pan</span>
      </div>

      {/* Bottom-left: legend */}
      <div
        class="mono absolute grid grid-cols-2"
        style={{
          bottom: '12px',
          left: '12px',
          'font-size': '9.5px',
          padding: '6px 10px',
          background: 'rgba(15,15,20,0.78)',
          border: '1px solid var(--bg-line)',
          'border-radius': '3px',
          color: 'var(--fg-2)',
          'backdrop-filter': 'blur(6px)',
          gap: '3px 12px',
        }}
      >
        <span>● color</span>
        <span style={{ color: 'var(--fg-3)' }}>= package</span>
        <span style={{ color: '#fff' }}>● white</span>
        <span style={{ color: 'var(--fg-3)' }}>= active edit</span>
        <span style={{ color: 'var(--yellow)' }}>○ yellow</span>
        <span style={{ color: 'var(--fg-3)' }}>= 1-hop impacted</span>
        <span style={{ color: 'rgba(255,255,255,0.7)' }}>◎ halo</span>
        <span style={{ color: 'var(--fg-3)' }}>= hub file</span>
      </div>

      {/* Bottom-right: zoom controls */}
      <div
        class="absolute flex gap-1"
        style={{ bottom: '12px', right: '12px' }}
      >
        <ZoomBtn onClick={() => inst?.zoomOut()}>−</ZoomBtn>
        <ZoomBtn onClick={() => inst?.frameAll()}>fit</ZoomBtn>
        <ZoomBtn onClick={() => inst?.zoomIn()}>+</ZoomBtn>
      </div>
    </div>
  )
}

function ZoomBtn(props: { onClick: () => void; children: string }) {
  return (
    <button
      onClick={props.onClick}
      class="mono"
      style={{
        width: '28px',
        height: '28px',
        'font-size': '13px',
        background: 'rgba(15,15,20,0.85)',
        color: 'var(--fg-1)',
        border: '1px solid var(--bg-line)',
        'border-radius': '3px',
        cursor: 'pointer',
        'backdrop-filter': 'blur(6px)',
      }}
    >
      {props.children}
    </button>
  )
}
