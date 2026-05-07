import { For, Show } from 'solid-js'
import { store } from '../store.js'

function fmtRelTime(epochSec: number): string {
  const diff = Date.now() / 1000 - epochSec
  if (diff < 60) return `${Math.floor(diff)}s`
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`
  return `${Math.floor(diff / 86400)}j`
}

export function CommitsPanel() {
  return (
    <div class="h-full flex flex-col">
      <div class="px-3 py-2 border-b border-zinc-800 flex items-center justify-between">
        <span class="text-xs uppercase tracking-wider text-zinc-400">Commits récents</span>
        <Show when={store.commits()}>
          {(c) => <span class="text-xs text-zinc-500">{c().count}</span>}
        </Show>
      </div>
      <div class="flex-1 overflow-y-auto">
        <Show when={store.commits()}>
          {(c) => (
            <ul class="divide-y divide-zinc-900">
              <For each={c().commits}>
                {(commit) => (
                  <li class="px-3 py-1.5 text-[11px] flex items-center gap-2">
                    <span class="text-zinc-600 w-10 shrink-0">{fmtRelTime(commit.ts)}</span>
                    <code class="text-amber-500/80 shrink-0">{commit.shortSha}</code>
                    <span class="text-zinc-300 truncate flex-1" title={commit.subject}>
                      {commit.subject}
                    </span>
                    <span class="text-zinc-600 shrink-0">{commit.filesChanged}f</span>
                  </li>
                )}
              </For>
            </ul>
          )}
        </Show>
      </div>
    </div>
  )
}
