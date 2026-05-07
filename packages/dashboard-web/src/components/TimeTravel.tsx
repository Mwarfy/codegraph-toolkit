import { For, Show, createMemo } from 'solid-js'
import type { SnapshotEntry } from '../lib/api.js'
import { store } from '../store.js'

function fmtDate(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

interface DotProps {
  entry: SnapshotEntry
  total: number
  isPinned: boolean
  isLatest: boolean
}

function SnapshotDot(props: DotProps) {
  const onClick = (): void => {
    if (props.isPinned) {
      store.setPinnedFile(null) // unpin
    } else {
      store.setPinnedFile(props.entry.file)
    }
  }
  const cls = (): string => {
    if (props.isPinned) return 'bg-amber-400 ring-2 ring-amber-300'
    if (props.isLatest) return 'bg-emerald-400 hover:bg-emerald-300'
    return 'bg-zinc-600 hover:bg-zinc-400'
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${props.entry.sha} · ${fmtDate(props.entry.isoDate)}`}
      class={`h-2 w-2 rounded-full transition-all flex-shrink-0 cursor-pointer ${cls()}`}
    />
  )
}

export function TimeTravelBar() {
  const list = createMemo(() => store.snapshotsList())
  const latestFile = createMemo(() => {
    const l = list()
    if (!l || l.snapshots.length === 0) return null
    return l.snapshots[l.snapshots.length - 1].file
  })

  const pinnedEntry = createMemo<SnapshotEntry | null>(() => {
    const l = list()
    const p = store.pinnedFile()
    if (!l || !p) return null
    return l.snapshots.find((s) => s.file === p) ?? null
  })

  return (
    <div class="h-9 border-t border-zinc-800 px-3 flex items-center gap-3 text-[11px] bg-zinc-950">
      <span class="uppercase tracking-wider text-zinc-500 shrink-0">Time-travel</span>

      <Show when={list()} fallback={<span class="text-zinc-600">…</span>}>
        {(l) => (
          <>
            <div class="flex-1 flex items-center gap-1 overflow-x-auto py-1 min-w-0">
              <For each={l().snapshots}>
                {(entry) => (
                  <SnapshotDot
                    entry={entry}
                    total={l().count}
                    isPinned={store.pinnedFile() === entry.file}
                    isLatest={latestFile() === entry.file}
                  />
                )}
              </For>
            </div>
            <span class="text-zinc-500 shrink-0">{l().count} snapshots</span>
          </>
        )}
      </Show>

      <Show
        when={pinnedEntry()}
        fallback={
          <span class="shrink-0 px-2 py-0.5 bg-emerald-500/10 text-emerald-400 rounded">LIVE</span>
        }
      >
        {(p) => (
          <button
            type="button"
            onClick={() => store.setPinnedFile(null)}
            class="shrink-0 px-2 py-0.5 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 rounded flex items-center gap-1.5"
            title="Cliquer pour revenir au live"
          >
            <span>PINNED</span>
            <code class="text-amber-200">{p().sha}</code>
            <span class="text-zinc-400">·</span>
            <span>{fmtDate(p().isoDate)}</span>
            <span class="ml-1 text-amber-200">×</span>
          </button>
        )}
      </Show>
    </div>
  )
}
