import { For, Show, createMemo, createResource } from 'solid-js'
import { api } from '../lib/api.js'
import { store } from '../store.js'

/**
 * Compares the pinned snapshot against the snapshot immediately before it
 * in chronological order — the natural "what changed when this commit
 * landed?" view. If no pin, shows nothing (TensionsPanel takes over).
 */

interface DeltaPair {
  file: string
}

function listSection(props: {
  title: string
  count: number
  items: string[]
  color: string
}) {
  return (
    <Show when={props.count > 0}>
      <details class="border-t border-zinc-900">
        <summary class={`px-3 py-1.5 text-xs cursor-pointer hover:bg-zinc-900/50 ${props.color}`}>
          {props.title} ({props.count})
        </summary>
        <ul class="bg-zinc-900/30 max-h-40 overflow-y-auto">
          <For each={props.items.slice(0, 50)}>
            {(item) => (
              <li class="px-3 py-1 text-[11px] text-zinc-300 truncate" title={item}>
                {item}
              </li>
            )}
          </For>
          <Show when={props.items.length > 50}>
            <li class="px-3 py-1 text-[11px] text-zinc-600 italic">
              … {props.items.length - 50} autres
            </li>
          </Show>
        </ul>
      </details>
    </Show>
  )
}

export function DiffPanel() {
  const pair = createMemo<{ from: string; to: string } | null>(() => {
    const list = store.snapshotsList()
    const pinned = store.pinnedFile()
    if (!list || !pinned) return null
    const idx = list.snapshots.findIndex((s) => s.file === pinned)
    if (idx <= 0) return null
    return { from: list.snapshots[idx - 1].file, to: pinned }
  })

  const [diff] = createResource(pair, async (p) => (p ? api.diff(p.from, p.to) : null))

  return (
    <div class="h-full flex flex-col">
      <div class="px-3 py-2 border-b border-zinc-800 flex items-center justify-between">
        <span class="text-xs uppercase tracking-wider text-amber-400">Diff vs précédent</span>
        <Show when={pair()}>
          {(p) => (
            <span class="text-[10px] text-zinc-500">
              {p().from.match(/-([a-f0-9]+)\.json$/)?.[1] ?? '?'} →{' '}
              {p().to.match(/-([a-f0-9]+)\.json$/)?.[1] ?? '?'}
            </span>
          )}
        </Show>
      </div>

      <Show
        when={pair()}
        fallback={
          <div class="p-3 text-xs text-zinc-600">
            Pinne un snapshot dans la timeline pour voir ce qu'il a changé.
          </div>
        }
      >
        <Show when={diff()} fallback={<div class="p-3 text-xs text-zinc-600">Calcul…</div>}>
          {(d) => (
            <div class="flex-1 overflow-y-auto">
              <div class="px-3 py-2 grid grid-cols-3 gap-2 text-xs border-b border-zinc-800">
                <div>
                  <div class="text-[10px] uppercase text-zinc-500">Nodes</div>
                  <div>
                    <span class="text-emerald-400">+{d().nodes.added.length}</span>
                    <span class="text-zinc-600 mx-1">/</span>
                    <span class="text-red-400">−{d().nodes.removed.length}</span>
                  </div>
                </div>
                <div>
                  <div class="text-[10px] uppercase text-zinc-500">Edges</div>
                  <div>
                    <span class="text-emerald-400">+{d().edges.added.length}</span>
                    <span class="text-zinc-600 mx-1">/</span>
                    <span class="text-red-400">−{d().edges.removed.length}</span>
                  </div>
                </div>
                <div>
                  <div class="text-[10px] uppercase text-zinc-500">Cycles</div>
                  <div>
                    <span class={d().tensions.cyclesAdded > 0 ? 'text-red-400' : 'text-zinc-600'}>
                      +{d().tensions.cyclesAdded}
                    </span>
                    <span class="text-zinc-600 mx-1">/</span>
                    <span class={d().tensions.cyclesRemoved > 0 ? 'text-emerald-400' : 'text-zinc-600'}>
                      −{d().tensions.cyclesRemoved}
                    </span>
                  </div>
                </div>
              </div>

              {listSection({
                title: 'Nodes ajoutés',
                count: d().nodes.added.length,
                items: d().nodes.added,
                color: 'text-emerald-400',
              })}
              {listSection({
                title: 'Nodes supprimés',
                count: d().nodes.removed.length,
                items: d().nodes.removed,
                color: 'text-red-400',
              })}
              {listSection({
                title: 'Edges ajoutées',
                count: d().edges.added.length,
                items: d().edges.added,
                color: 'text-emerald-400',
              })}
              {listSection({
                title: 'Edges supprimées',
                count: d().edges.removed.length,
                items: d().edges.removed,
                color: 'text-red-400',
              })}

              <div class="px-3 py-2 border-t border-zinc-900 text-[11px] text-zinc-500">
                <div>
                  Long fns : <span class="text-emerald-400">+{d().tensions.longFunctionsAdded}</span> /{' '}
                  <span class="text-red-400">−{d().tensions.longFunctionsRemoved}</span>
                </div>
                <div>
                  Barrels low-value : <span class="text-emerald-400">+{d().tensions.barrelsLowAdded}</span> /{' '}
                  <span class="text-red-400">−{d().tensions.barrelsLowRemoved}</span>
                </div>
              </div>
            </div>
          )}
        </Show>
      </Show>
    </div>
  )
}
