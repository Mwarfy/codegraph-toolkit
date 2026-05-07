import { For, Show } from 'solid-js'
import { store } from '../store.js'

const KIND_COLORS: Record<string, string> = {
  cycle: 'bg-red-500/20 text-red-300 border-red-500/40',
  orphan: 'bg-zinc-500/20 text-zinc-300 border-zinc-500/40',
  'barrel-low': 'bg-purple-500/20 text-purple-300 border-purple-500/40',
  'long-fn': 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  drift: 'bg-blue-500/20 text-blue-300 border-blue-500/40',
}

export function TensionsPanel() {
  return (
    <div class="h-full flex flex-col">
      <div class="px-3 py-2 border-b border-zinc-800 flex items-center justify-between">
        <span class="text-xs uppercase tracking-wider text-zinc-400">Tensions actives</span>
        <Show when={store.tensions()}>
          {(t) => <span class="text-xs text-zinc-500">{t().count}</span>}
        </Show>
      </div>
      <div class="flex-1 overflow-y-auto">
        <Show
          when={store.tensions()}
          fallback={<div class="p-3 text-zinc-500 text-xs">Chargement…</div>}
        >
          {(t) => (
            <Show
              when={t().count > 0}
              fallback={<div class="p-3 text-emerald-400 text-xs">✓ aucune tension détectée</div>}
            >
              <ul class="divide-y divide-zinc-900">
                <For each={t().tensions}>
                  {(tension) => (
                    <li class="px-3 py-2 hover:bg-zinc-900/50">
                      <div class="flex items-start gap-2">
                        <span
                          class={`px-1.5 py-0.5 text-[10px] uppercase rounded border ${KIND_COLORS[tension.kind] ?? 'bg-zinc-700 text-zinc-300 border-zinc-600'}`}
                        >
                          {tension.kind}
                        </span>
                        <div class="flex-1 min-w-0">
                          <div class="text-xs text-zinc-200 truncate">{tension.target}</div>
                          <div class="text-[11px] text-zinc-500 mt-0.5">{tension.detail}</div>
                          <div class="text-[11px] text-zinc-600 mt-1 italic">→ {tension.hint}</div>
                        </div>
                      </div>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          )}
        </Show>
      </div>
    </div>
  )
}
