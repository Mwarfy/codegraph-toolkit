import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { store } from '../store.js'

const WINDOW_MS = 5 * 60 * 1000 // 5-minute rolling window

interface DotProps {
  leftPct: number
  topPct: number
  size: number
  color: string
  title: string
  isDedup: boolean
}

function EventDot(props: DotProps) {
  return (
    <div
      class={`absolute rounded-full ${props.isDedup ? 'opacity-40' : 'opacity-90'} hover:opacity-100`}
      style={{
        left: `${props.leftPct}%`,
        top: `${props.topPct}%`,
        width: `${props.size}px`,
        height: `${props.size}px`,
        background: props.color,
        transform: 'translate(-50%, -50%)',
      }}
      title={props.title}
    />
  )
}

/**
 * Horizontal hooks-fired timeline. Each dot = one PreToolUse / PostToolUse
 * injection. Position = recency, color = event kind, size = token cost,
 * faded = dedup hit. Helps spot bursts and patterns the vertical feed
 * cannot.
 */
export function CallTimeline() {
  const [now, setNow] = createSignal(Date.now())
  let timer: number | undefined
  onMount(() => {
    timer = window.setInterval(() => setNow(Date.now()), 2000)
  })
  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  const records = createMemo(() => {
    const cutoff = now() - WINDOW_MS
    return store.liveTelemetry().filter((r) => r.ts * 1000 >= cutoff)
  })

  const dots = createMemo<DotProps[]>(() => {
    const out: DotProps[] = []
    for (const r of records()) {
      const recencyMs = now() - r.ts * 1000
      const leftPct = 100 - (recencyMs / WINDOW_MS) * 100
      const isPre = r.event === 'PreToolUse'
      const baseSize = Math.min(12, 3 + Math.log2(r.tokensApprox + 1))
      out.push({
        leftPct,
        topPct: isPre ? 30 : 70,
        size: baseSize,
        color: isPre ? '#3b82f6' : '#10b981',
        title: `${r.event} · ${r.file} · ${r.tokensApprox} tok${r.dedupHit ? ' (dedup)' : ''}`,
        isDedup: r.dedupHit,
      })
    }
    return out
  })

  const tickPct = (minutesAgo: number) => 100 - (minutesAgo / 5) * 100

  return (
    <div class="border-b border-zinc-800 px-3 py-2">
      <div class="flex items-center justify-between mb-1">
        <span class="text-[10px] uppercase text-zinc-500">Hooks · 5min</span>
        <span class="text-[10px] text-zinc-500">{records().length} évts</span>
      </div>
      <div class="relative h-12 bg-zinc-900/50 rounded">
        {/* Horizontal grid lines for PRE / POST tracks */}
        <div class="absolute inset-x-0 top-[30%] h-px bg-zinc-800/50" />
        <div class="absolute inset-x-0 top-[70%] h-px bg-zinc-800/50" />

        {/* Time ticks */}
        <For each={[5, 4, 3, 2, 1, 0]}>
          {(min) => (
            <div
              class="absolute top-0 bottom-0 w-px bg-zinc-800/30"
              style={{ left: `${tickPct(min)}%` }}
            />
          )}
        </For>

        {/* Track labels */}
        <span class="absolute left-1 top-[20%] text-[9px] text-blue-400/60">PRE</span>
        <span class="absolute left-1 top-[60%] text-[9px] text-emerald-400/60">POST</span>

        {/* Event dots */}
        <For each={dots()}>{(d) => <EventDot {...d} />}</For>

        <Show when={records().length === 0}>
          <div class="absolute inset-0 flex items-center justify-center text-[10px] text-zinc-600">
            aucun hook dans la fenêtre — édite un fichier pour voir
          </div>
        </Show>
      </div>
      <div class="flex justify-between text-[9px] text-zinc-600 mt-1">
        <span>−5min</span>
        <span>−4</span>
        <span>−3</span>
        <span>−2</span>
        <span>−1</span>
        <span>maintenant</span>
      </div>
    </div>
  )
}
