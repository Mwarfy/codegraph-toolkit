import { Show, createMemo, createSignal } from 'solid-js'
import { Header } from './components/Header.js'
import { CockpitTree } from './components/CockpitTree.js'
import { CockpitCosmos } from './components/CockpitCosmos.js'
import { CockpitPipeline, type StagePins } from './components/CockpitPipeline.js'
import { TimeTravelBar } from './components/TimeTravel.js'
import { PayloadViewer } from './components/PayloadViewer.js'
import { store } from './store.js'
import { buildDatasetFromSnapshot, type CosmosNode } from './lib/cosmos.js'

export function App() {
  const snapshot = () => store.snapshot()
  const dataset = createMemo(() => buildDatasetFromSnapshot(snapshot()))

  const [hoveredStage, setHoveredStage] = createSignal<string | null>(null)
  const [pins, setPins] = createSignal<StagePins>({})
  const [hostRect, setHostRect] = createSignal<DOMRect | null>(null)
  const [, setHoverNode] = createSignal<CosmosNode | null>(null)
  const [treeHover, setTreeHover] = createSignal<CosmosNode | null>(null)

  // Resolve the live "touched" file (from telemetry) to a cosmos node id.
  // The store stores it as a path; we accept either id or label match.
  const activeNode = createMemo<CosmosNode | null>(() => {
    const f = store.lastTouchedFile()
    if (!f) return null
    const ds = dataset()
    return ds.byApiId.get(f) ?? ds.byPath.get(f) ?? null
  })
  const activeApiId = () => activeNode()?.apiId ?? null
  const activeFilePath = () => activeNode()?.path ?? null

  const impactedNodes = createMemo<CosmosNode[]>(() => {
    const ds = dataset()
    return ds.nodes.filter((n) => n.impacted)
  })
  const impactedIds = createMemo(() => new Set(impactedNodes().map((n) => n.id)))
  const impactedFiles = createMemo(() => impactedNodes().map((n) => n.path))

  // Per-stage impacts: for now, every stage projects to the active file +
  // its 1-hop neighbourhood. As we wire real per-hook payload analysis on
  // the server, this is where it'll plug in.
  const stageImpacts = createMemo<Record<string, string[]>>(() => {
    const a = activeApiId()
    if (!a) return { pre: [], post: [], ctx: [], stop: [] }
    const all = [a, ...impactedFiles()]
    return {
      pre: [a],
      post: all.slice(0, 8),
      ctx: all,
      stop: [a],
    }
  })

  function onClickNode(n: CosmosNode): void {
    store.setFocusedNode(n.apiId)
  }

  return (
    <div class="h-screen flex flex-col" style={{ background: 'var(--bg-0)' }}>
      <Header />
      <div
        class="flex-1 grid min-h-0"
        style={{ 'grid-template-columns': '260px 1fr 320px' }}
      >
        <Show
          when={dataset().nodes.length > 0}
          fallback={
            <div
              class="mono col-span-3 flex items-center justify-center"
              style={{ color: 'var(--fg-3)' }}
            >
              chargement du snapshot…
            </div>
          }
        >
          <CockpitTree
            dataset={dataset()}
            activeId={activeNode()?.id ?? null}
            impactedIds={impactedIds()}
            hoveredId={treeHover()?.id ?? null}
            onHover={setTreeHover}
            onClick={onClickNode}
          />
          <CockpitCosmos
            dataset={dataset()}
            activeApiId={activeApiId()}
            hoveredStage={hoveredStage}
            pins={pins}
            stageImpacts={stageImpacts}
            treeHoverId={() => treeHover()?.id ?? null}
            setHoverNode={setHoverNode}
            onClickNode={onClickNode}
            setHostRect={setHostRect}
          />
          <CockpitPipeline
            hostRect={hostRect}
            setPins={setPins}
            setHoveredStage={setHoveredStage}
            activeFile={activeFilePath()}
            impactedFiles={impactedFiles()}
          />
        </Show>
      </div>
      <TimeTravelBar />
      <PayloadViewer />
    </div>
  )
}
