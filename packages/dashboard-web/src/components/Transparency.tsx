import { For, Show, createMemo } from 'solid-js'
import { store } from '../store.js'
import { CallTimeline } from './CallTimeline.js'
import { TokenSparkline } from './TokenSparkline.js'

function fmtTokens(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

function fmtAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  return `${Math.floor(seconds / 3600)}h`
}

export function TransparencyPanel() {
  const summary = () => store.telemetrySummary()
  const live = () => store.liveTelemetry()

  // Estimated dedup ratio (saved / would-have-been-injected)
  const dedupRatio = createMemo(() => {
    const s = summary()
    if (!s) return 0
    const wouldBe = s.totalTokensApprox + s.dedupSavedTokens
    return wouldBe > 0 ? s.dedupSavedTokens / wouldBe : 0
  })

  return (
    <div class="h-full flex flex-col">
      <div class="px-3 py-2 border-b border-zinc-800 flex items-center justify-between">
        <span class="text-xs uppercase tracking-wider text-zinc-400">Transparence agent</span>
        <Show when={summary()}>
          {(s) => (
            <span class="text-xs text-zinc-500">
              {s().totalEvents} hooks · {fmtTokens(s().totalTokensApprox)} tok
            </span>
          )}
        </Show>
      </div>

      <Show when={summary()}>
        {(s) => (
          <div class="px-3 py-2 border-b border-zinc-800 grid grid-cols-3 gap-2 text-xs">
            <div>
              <div class="text-zinc-500 text-[10px] uppercase">Tokens injectés</div>
              <div class="text-emerald-400 font-semibold">{fmtTokens(s().totalTokensApprox)}</div>
            </div>
            <div>
              <div class="text-zinc-500 text-[10px] uppercase">Dedup hits</div>
              <div class="text-amber-400 font-semibold">
                {s().dedupHits} / {s().totalEvents}
              </div>
            </div>
            <div>
              <div class="text-zinc-500 text-[10px] uppercase">Économisés</div>
              <div class="text-blue-400 font-semibold">
                {fmtTokens(s().dedupSavedTokens)} ({(dedupRatio() * 100).toFixed(0)}%)
              </div>
            </div>
          </div>
        )}
      </Show>

      <TokenSparkline />
      <CallTimeline />

      <div class="px-3 py-2 border-b border-zinc-800 text-[11px] text-zinc-500">
        <span>Hooks observés : </span>
        <Show when={summary()}>
          {(s) => (
            <For each={Object.entries(s().byHook)}>
              {([name, v]) => (
                <span class="ml-2 text-zinc-400">
                  <span class="text-emerald-500">{name}</span> {v.count}× ({fmtTokens(v.tokens)} tok)
                </span>
              )}
            </For>
          )}
        </Show>
      </div>

      <div class="flex-1 overflow-y-auto">
        <div class="px-3 py-1.5 text-[10px] uppercase text-zinc-500 sticky top-0 bg-zinc-950/90">
          Live feed (newest first)
        </div>
        <Show when={live().length > 0} fallback={<div class="p-3 text-zinc-600 text-xs">Aucun hook observé. Édite un fichier .ts pour voir.</div>}>
          <ul class="divide-y divide-zinc-900">
            <For each={live()}>
              {(rec) => {
                const ageSec = Math.max(0, Math.floor((Date.now() - rec.ts * 1000) / 1000))
                return (
                  <li class="px-3 py-1.5 text-[11px] flex items-center gap-2">
                    <span class="text-zinc-600 w-10 shrink-0">{fmtAge(ageSec)}</span>
                    <span
                      class={`shrink-0 px-1 rounded text-[10px] ${
                        rec.event === 'PreToolUse'
                          ? 'bg-blue-500/20 text-blue-300'
                          : 'bg-emerald-500/20 text-emerald-300'
                      }`}
                    >
                      {rec.event === 'PreToolUse' ? 'PRE' : 'POST'}
                    </span>
                    <span class="text-zinc-400 truncate flex-1" title={rec.file}>
                      {rec.file}
                    </span>
                    <span class={`shrink-0 ${rec.dedupHit ? 'text-zinc-600' : 'text-emerald-400'}`}>
                      {fmtTokens(rec.tokensApprox)}t
                      <Show when={rec.dedupHit}>
                        <span class="ml-1 text-amber-500" title={`dedup ${rec.dedupAgeSec}s`}>
                          ⤴
                        </span>
                      </Show>
                    </span>
                  </li>
                )
              }}
            </For>
          </ul>
        </Show>
      </div>
    </div>
  )
}
