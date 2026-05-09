import { For, Show, createMemo, createSignal } from 'solid-js'
import type { CosmosDataset, CosmosNode } from '../lib/cosmos.js'

interface DirGroup {
  name: string
  files: CosmosNode[]
}

interface PkgGroup {
  name: string
  color: string
  count: number
  dirs: DirGroup[]
}

function buildTree(dataset: CosmosDataset): PkgGroup[] {
  const pkgs = new Map<string, { color: string; dirs: Map<string, CosmosNode[]>; count: number }>()
  for (const n of dataset.nodes) {
    let p = pkgs.get(n.pkg)
    if (!p) {
      p = { color: n.color, dirs: new Map(), count: 0 }
      pkgs.set(n.pkg, p)
    }
    let arr = p.dirs.get(n.dir)
    if (!arr) {
      arr = []
      p.dirs.set(n.dir, arr)
    }
    arr.push(n)
    p.count++
  }
  const out: PkgGroup[] = []
  for (const [name, p] of pkgs.entries()) {
    const dirs: DirGroup[] = []
    for (const [dirName, files] of p.dirs.entries()) {
      files.sort((a, b) => a.name.localeCompare(b.name))
      dirs.push({ name: dirName, files })
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name))
    out.push({ name, color: p.color, count: p.count, dirs })
  }
  out.sort((a, b) => b.count - a.count)
  return out
}

function kindGlyph(kind: string): string {
  if (kind === 'tsx') return 'jsx'
  if (kind === 'test') return 'tst'
  if (kind === 'barrel') return 'brl'
  if (kind === 'config') return 'cfg'
  if (kind === 'dl') return 'dl'
  if (kind === 'sql') return 'sql'
  if (kind === 'md') return 'md'
  return 'ts'
}

interface FileRowProps {
  node: CosmosNode
  depth: number
  activeId: number | null
  impactedIds: Set<number>
  hoveredId: number | null
  onHover: (n: CosmosNode | null) => void
  onClick: (n: CosmosNode) => void
}

function FileRow(props: FileRowProps) {
  const isActive = () => props.node.id === props.activeId
  const isImpacted = () => props.impactedIds.has(props.node.id)
  const isHover = () => props.hoveredId === props.node.id

  return (
    <div
      onMouseEnter={() => props.onHover(props.node)}
      onMouseLeave={() => props.onHover(null)}
      onClick={() => props.onClick(props.node)}
      class="mono flex items-center gap-1.5 cursor-pointer text-[10.5px] py-[1px]"
      style={{
        'padding-left': `${6 + props.depth * 12}px`,
        'padding-right': '6px',
        background: isActive()
          ? 'rgba(255,255,255,0.08)'
          : isHover()
          ? 'rgba(120,200,220,0.10)'
          : isImpacted()
          ? 'rgba(255,210,90,0.06)'
          : 'transparent',
        'border-left': isActive()
          ? '2px solid #fff'
          : isImpacted()
          ? '2px solid var(--yellow)'
          : '2px solid transparent',
      }}
    >
      <span
        class="shrink-0 rounded-full"
        style={{
          width: '7px',
          height: '7px',
          background: props.node.color,
          'box-shadow': isActive()
            ? '0 0 6px rgba(255,255,255,0.7)'
            : isImpacted()
            ? '0 0 4px rgba(255,210,90,0.6)'
            : 'none',
        }}
      />
      <span
        class="shrink-0 uppercase"
        style={{ width: '20px', 'font-size': '8.5px', color: 'var(--fg-3)', opacity: 0.7 }}
      >
        {kindGlyph(props.node.kind)}
      </span>
      <span
        class="flex-1 truncate"
        style={{
          color: isActive()
            ? '#fff'
            : isImpacted()
            ? 'var(--yellow)'
            : isHover()
            ? 'var(--fg-0)'
            : 'var(--fg-1)',
          'font-weight': isActive() ? 600 : 400,
        }}
      >
        {props.node.name}
      </span>
      <Show when={props.node.hub}>
        <span class="shrink-0" style={{ 'font-size': '8.5px', color: 'rgba(255,255,255,0.5)' }}>
          HUB
        </span>
      </Show>
      <Show when={props.node.hot}>
        <span class="shrink-0" style={{ 'font-size': '8.5px', color: 'var(--yellow)' }}>
          ●
        </span>
      </Show>
    </div>
  )
}

interface DirRowProps {
  dir: DirGroup
  expanded: boolean
  onToggle: () => void
  activeId: number | null
  impactedIds: Set<number>
  hoveredId: number | null
  onHover: (n: CosmosNode | null) => void
  onClick: (n: CosmosNode) => void
}

function DirRow(props: DirRowProps) {
  const hasActive = () => props.dir.files.some((f) => f.id === props.activeId)
  const impactedCount = () => props.dir.files.filter((f) => props.impactedIds.has(f.id)).length

  return (
    <>
      <div
        onClick={props.onToggle}
        class="mono flex items-center gap-1 cursor-pointer select-none py-[1px] pr-1.5"
        style={{
          'padding-left': '18px',
          color: 'var(--fg-2)',
          background: hasActive() ? 'rgba(255,255,255,0.04)' : 'transparent',
        }}
      >
        <span style={{ 'font-size': '9px', width: '8px', color: 'var(--fg-3)' }}>
          {props.expanded ? '▾' : '▸'}
        </span>
        <span style={{ 'font-size': '10.5px', color: 'var(--fg-1)', 'font-weight': 500 }}>
          {props.dir.name}/
        </span>
        <span class="ml-auto" style={{ 'font-size': '9px', color: 'var(--fg-3)' }}>
          {props.dir.files.length}
          <Show when={impactedCount() > 0}>
            <span style={{ color: 'var(--yellow)', 'margin-left': '4px' }}>·{impactedCount()}</span>
          </Show>
        </span>
      </div>
      <Show when={props.expanded}>
        <For each={props.dir.files}>
          {(f) => (
            <FileRow
              node={f}
              depth={3}
              activeId={props.activeId}
              impactedIds={props.impactedIds}
              hoveredId={props.hoveredId}
              onHover={props.onHover}
              onClick={props.onClick}
            />
          )}
        </For>
      </Show>
    </>
  )
}

interface PkgRowProps {
  pkg: PkgGroup
  defaultExpanded: boolean
  activeId: number | null
  impactedIds: Set<number>
  hoveredId: number | null
  onHover: (n: CosmosNode | null) => void
  onClick: (n: CosmosNode) => void
}

function PkgRow(props: PkgRowProps) {
  const [expanded, setExpanded] = createSignal(props.defaultExpanded)
  const initialOpen = new Set<string>()
  for (const d of props.pkg.dirs) {
    if (d.files.some((f) => f.id === props.activeId || props.impactedIds.has(f.id))) {
      initialOpen.add(d.name)
    }
  }
  const [openDirs, setOpenDirs] = createSignal(initialOpen)

  const hasActive = () => props.pkg.dirs.some((d) => d.files.some((f) => f.id === props.activeId))
  const impactedCount = () =>
    props.pkg.dirs.reduce((acc, d) => acc + d.files.filter((f) => props.impactedIds.has(f.id)).length, 0)

  return (
    <div>
      <div
        onClick={() => setExpanded((v) => !v)}
        class="mono flex items-center gap-1.5 cursor-pointer select-none py-[4px] px-1.5"
        style={{
          background: hasActive() ? 'rgba(255,255,255,0.06)' : 'transparent',
          'border-top': '1px solid var(--bg-line)',
        }}
      >
        <span style={{ 'font-size': '9px', width: '8px', color: 'var(--fg-3)' }}>
          {expanded() ? '▾' : '▸'}
        </span>
        <span
          class="shrink-0 rounded-full"
          style={{
            width: '9px',
            height: '9px',
            background: props.pkg.color,
            'box-shadow': `0 0 4px ${props.pkg.color}80`,
          }}
        />
        <span style={{ 'font-size': '11px', color: 'var(--fg-0)', 'font-weight': 600 }}>
          {props.pkg.name}
        </span>
        <span class="flex-1" />
        <span class="tnum" style={{ 'font-size': '9px', color: 'var(--fg-3)' }}>
          {props.pkg.count}
        </span>
        <Show when={impactedCount() > 0}>
          <span class="tnum" style={{ 'font-size': '9px', color: 'var(--yellow)' }}>
            ·{impactedCount()}
          </span>
        </Show>
        <Show when={hasActive()}>
          <span style={{ 'font-size': '9px', color: '#fff' }}>◆</span>
        </Show>
      </div>
      <Show when={expanded()}>
        <For each={props.pkg.dirs}>
          {(d) => (
            <DirRow
              dir={d}
              expanded={openDirs().has(d.name)}
              onToggle={() => {
                const s = new Set(openDirs())
                if (s.has(d.name)) s.delete(d.name)
                else s.add(d.name)
                setOpenDirs(s)
              }}
              activeId={props.activeId}
              impactedIds={props.impactedIds}
              hoveredId={props.hoveredId}
              onHover={props.onHover}
              onClick={props.onClick}
            />
          )}
        </For>
      </Show>
    </div>
  )
}

interface CockpitTreeProps {
  dataset: CosmosDataset
  activeId: number | null
  impactedIds: Set<number>
  hoveredId: number | null
  onHover: (n: CosmosNode | null) => void
  onClick: (n: CosmosNode) => void
}

export function CockpitTree(props: CockpitTreeProps) {
  const [filter, setFilter] = createSignal('')
  const tree = createMemo(() => buildTree(props.dataset))
  const filtered = createMemo(() => {
    const q = filter().toLowerCase().trim()
    if (!q) return tree()
    return tree()
      .map((p) => ({
        ...p,
        dirs: p.dirs
          .map((d) => ({
            ...d,
            files: d.files.filter((f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)),
          }))
          .filter((d) => d.files.length > 0),
      }))
      .filter((p) => p.dirs.length > 0)
  })

  return (
    <div
      class="flex flex-col h-full min-h-0"
      style={{ background: 'var(--bg-1)', 'border-right': '1px solid var(--bg-line)' }}
    >
      <div
        class="flex flex-col gap-1.5 px-3 py-2.5"
        style={{ 'border-bottom': '1px solid var(--bg-line)' }}
      >
        <div class="flex items-baseline gap-2">
          <span
            class="mono uppercase"
            style={{
              'font-size': '10.5px',
              color: 'var(--fg-1)',
              'font-weight': 600,
              'letter-spacing': '0.08em',
            }}
          >
            Project
          </span>
          <span class="flex-1" />
          <span class="mono" style={{ 'font-size': '9.5px', color: 'var(--fg-3)' }}>
            {props.dataset.nodes.length} files
          </span>
        </div>
        <input
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
          placeholder="filter…"
          class="mono px-2 py-1 outline-none"
          style={{
            background: 'var(--bg-0)',
            border: '1px solid var(--bg-line)',
            'border-radius': '3px',
            color: 'var(--fg-1)',
            'font-size': '10.5px',
          }}
        />
      </div>
      <div class="flex-1 overflow-y-auto min-h-0">
        <For each={filtered()}>
          {(p, i) => (
            <PkgRow
              pkg={p}
              defaultExpanded={i() < 4 || p.dirs.some((d) => d.files.some((f) => f.id === props.activeId))}
              activeId={props.activeId}
              impactedIds={props.impactedIds}
              hoveredId={props.hoveredId}
              onHover={props.onHover}
              onClick={props.onClick}
            />
          )}
        </For>
      </div>
      <div
        class="mono px-3 py-2"
        style={{
          'border-top': '1px solid var(--bg-line)',
          'font-size': '9.5px',
          color: 'var(--fg-3)',
          'line-height': 1.5,
        }}
      >
        <div>
          ● <span style={{ color: 'var(--fg-2)' }}>color = pkg</span>
        </div>
        <div>
          <span style={{ color: '#fff' }}>◆</span>{' '}
          <span style={{ color: 'var(--fg-2)' }}>contient le fichier actif</span>
        </div>
        <div>
          <span style={{ color: 'var(--yellow)' }}>·N</span>{' '}
          <span style={{ color: 'var(--fg-2)' }}>fichiers impactés</span>
        </div>
      </div>
    </div>
  )
}
