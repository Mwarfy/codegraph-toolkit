import { Show, createSignal, onCleanup, onMount } from 'solid-js'
import { store } from '../store.js'
import { api } from '../lib/api.js'

export function Header() {
  const [status, setStatus] = createSignal<{ ok: boolean; rootDir: string; wsClients: number } | null>(null)
  const [pulse, setPulse] = createSignal(false)

  let timer: number | undefined
  onMount(() => {
    const refresh = () => api.status().then(setStatus).catch(() => setStatus(null))
    refresh()
    timer = window.setInterval(refresh, 5000)
  })
  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  // Brief flash when a snapshot update lands
  let lastSnap = 0
  setInterval(() => {
    const snap = store.snapshot()
    if (snap && snap.mtime !== lastSnap) {
      if (lastSnap !== 0) {
        setPulse(true)
        setTimeout(() => setPulse(false), 600)
      }
      lastSnap = snap.mtime
    }
  }, 500)

  return (
    <header class="h-10 border-b border-zinc-800 px-4 flex items-center gap-4 text-xs">
      <span class="font-bold tracking-wider text-emerald-400">CODEGRAPH · COCKPIT</span>
      <span class="text-zinc-600">|</span>
      <Show when={status()}>
        {(s) => (
          <>
            <span class="text-zinc-400">root:</span>
            <code class="text-zinc-300 truncate max-w-md" title={s().rootDir}>
              {s().rootDir.split('/').slice(-2).join('/')}
            </code>
            <span class="text-zinc-600">|</span>
            <span class="text-zinc-400">ws:</span>
            <span class="text-emerald-400">{s().wsClients} client(s)</span>
          </>
        )}
      </Show>
      <Show when={store.snapshot()}>
        {(snap) => (
          <>
            <span class="text-zinc-600">|</span>
            <span class="text-zinc-400">graphe:</span>
            <span class="text-zinc-200">
              {snap().data.nodes.length} nodes · {snap().data.edges.length} edges
            </span>
          </>
        )}
      </Show>
      <span class="ml-auto flex items-center gap-2">
        <span class={`h-2 w-2 rounded-full ${pulse() ? 'bg-emerald-400' : 'bg-zinc-700'} transition-colors`} />
        <span class="text-zinc-500">live</span>
      </span>
    </header>
  )
}
