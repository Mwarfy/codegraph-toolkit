import { Show, createMemo } from 'solid-js'
import { store } from '../store.js'

/**
 * Small SVG sparkline of cumulative tokens injected by the toolkit's
 * hooks over the last N events. Reads store.liveTelemetry() (oldest →
 * newest from store order: newest first, so we reverse). Each event
 * accumulates tokensApprox into a running total; we render a polyline
 * normalized to the panel size.
 *
 * No data, no event = the chart is hidden (Show fallback handles it).
 */

const WIDTH = 200
const HEIGHT = 40

interface ChartData {
  points: string
  total: number
  count: number
  fillPath: string
}

function buildChart(records: Array<{ tokensApprox: number }>): ChartData | null {
  if (records.length < 2) return null
  // store.liveTelemetry holds newest-first; cumulative needs oldest-first.
  const ordered = [...records].reverse()
  let cumul = 0
  const cumuls: number[] = []
  for (const r of ordered) {
    cumul += r.tokensApprox
    cumuls.push(cumul)
  }
  const max = cumul || 1
  const stepX = WIDTH / (cumuls.length - 1)
  const pts = cumuls.map((y, i) => `${i * stepX},${HEIGHT - (y / max) * HEIGHT}`).join(' ')
  const fill = `M0,${HEIGHT} L${pts.replace(/ /g, ' L')} L${WIDTH},${HEIGHT} Z`
  return {
    points: pts,
    total: cumul,
    count: cumuls.length,
    fillPath: fill,
  }
}

export function TokenSparkline() {
  const chart = createMemo(() => buildChart(store.liveTelemetry()))

  return (
    <Show when={chart()}>
      {(c) => (
        <div class="px-3 py-2 border-b border-zinc-800">
          <div class="flex items-center justify-between mb-1 text-[10px]">
            <span class="uppercase text-zinc-500">Tokens cumulés · {c().count} évts</span>
            <span class="text-emerald-400 tabular-nums">
              {c().total >= 1000 ? `${(c().total / 1000).toFixed(1)}k` : c().total} tok
            </span>
          </div>
          <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            class="w-full h-10"
            preserveAspectRatio="none"
          >
            <path d={c().fillPath} fill="rgba(16, 185, 129, 0.12)" />
            <polyline
              points={c().points}
              fill="none"
              stroke="rgb(16, 185, 129)"
              stroke-width="1.2"
              vector-effect="non-scaling-stroke"
            />
          </svg>
        </div>
      )}
    </Show>
  )
}
