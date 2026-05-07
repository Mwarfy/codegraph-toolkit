import { For, Show, createMemo } from 'solid-js'
import { store } from '../store.js'

export function RuntimePanel() {
  const top = createMemo(() => {
    const r = store.runtime()
    if (!r) return []
    return r.timings.slice(0, 12)
  })
  const max = createMemo(() => {
    const t = top()
    return t.length > 0 ? t[0].p95Ms : 1
  })

  return (
    <div class="h-full flex flex-col">
      <div class="px-3 py-2 border-b border-zinc-800 flex items-center justify-between">
        <span class="text-xs uppercase tracking-wider text-zinc-400">Runtime — top p95</span>
        <Show when={store.runtime()}>
          {(r) => <span class="text-xs text-zinc-500">{r().count} détecteurs</span>}
        </Show>
      </div>
      <div class="flex-1 overflow-y-auto px-3 py-2">
        <Show when={top().length > 0} fallback={<div class="text-xs text-zinc-600">Pas de timings.</div>}>
          <For each={top()}>
            {(t) => {
              const pct = Math.min(100, (t.p95Ms / max()) * 100)
              const isUnstable = t.lambda > 5
              return (
                <div class="mb-1.5">
                  <div class="flex items-center justify-between text-[11px] mb-0.5">
                    <span class="text-zinc-300 truncate flex-1">{t.detector}</span>
                    <span class="text-zinc-500 ml-2 shrink-0">
                      {t.p95Ms.toFixed(0)}ms
                      <Show when={isUnstable}>
                        <span class="ml-1 text-amber-500" title={`λ=${t.lambda.toFixed(1)} (instable)`}>
                          ⚡
                        </span>
                      </Show>
                    </span>
                  </div>
                  <div class="h-1 bg-zinc-900 rounded-sm overflow-hidden">
                    <div
                      class={`h-full ${isUnstable ? 'bg-amber-500/60' : 'bg-emerald-500/60'}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              )
            }}
          </For>
        </Show>
      </div>
    </div>
  )
}
