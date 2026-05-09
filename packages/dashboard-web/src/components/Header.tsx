import { Show, createSignal, onCleanup, onMount } from 'solid-js'
import { store } from '../store.js'
import { api } from '../lib/api.js'

export function Header() {
  const [status, setStatus] = createSignal<{ ok: boolean; rootDir: string; wsClients: number } | null>(null)
  const [pulse, setPulse] = createSignal(false)

  let timer: number | undefined
  let pulseTimer: number | undefined
  let lastSnap = 0

  onMount(() => {
    const refresh = () => api.status().then(setStatus).catch(() => setStatus(null))
    refresh()
    timer = window.setInterval(refresh, 5000)
    pulseTimer = window.setInterval(() => {
      const snap = store.snapshot()
      if (!snap) return
      if (snap.mtime !== lastSnap) {
        if (lastSnap !== 0) {
          setPulse(true)
          window.setTimeout(() => setPulse(false), 600)
        }
        lastSnap = snap.mtime
      }
    }, 500)
  })

  onCleanup(() => {
    if (timer) clearInterval(timer)
    if (pulseTimer) clearInterval(pulseTimer)
  })

  return (
    <header
      class="flex items-center gap-4 mono"
      style={{
        height: '40px',
        padding: '0 16px',
        'border-bottom': '1px solid var(--bg-line)',
        background: 'var(--bg-1)',
        'font-size': '11px',
        'flex-shrink': 0,
      }}
    >
      <span
        class="uppercase"
        style={{
          'font-weight': 700,
          'letter-spacing': '0.08em',
          color: 'var(--fg-0)',
        }}
      >
        codegraph<span style={{ color: 'var(--cyan)' }}>·</span>cockpit
      </span>

      <Show when={status()}>
        {(s) => (
          <>
            <Divider />
            <span style={{ color: 'var(--fg-2)' }}>root</span>
            <code class="truncate max-w-md" style={{ color: 'var(--fg-1)' }} title={s().rootDir}>
              {s().rootDir.split('/').slice(-2).join('/')}
            </code>
            <Divider />
            <span style={{ color: 'var(--fg-2)' }}>ws</span>
            <span style={{ color: 'var(--green)' }}>{s().wsClients}</span>
          </>
        )}
      </Show>

      <Show when={store.snapshot()}>
        {(snap) => (
          <>
            <Divider />
            <span style={{ color: 'var(--fg-2)' }}>graph</span>
            <span class="tnum" style={{ color: 'var(--fg-0)' }}>
              {snap().data.nodes.length} · {snap().data.edges.length}
            </span>
          </>
        )}
      </Show>

      <button
        type="button"
        onClick={() => store.setViewer({ kind: 'boot' })}
        class="ml-auto"
        style={{
          padding: '3px 10px',
          'font-size': '10px',
          color: 'var(--cyan)',
          background: 'rgba(120,200,220,0.08)',
          border: '1px solid rgba(120,200,220,0.25)',
          'border-radius': '3px',
          cursor: 'pointer',
        }}
        title="Boot context envoyé à Claude au démarrage"
      >
        boot context
      </button>

      <input
        type="text"
        placeholder="filter…"
        value={store.filterPattern()}
        onInput={(e) => store.setFilterPattern(e.currentTarget.value)}
        class="mono"
        style={{
          background: 'var(--bg-2)',
          border: '1px solid var(--bg-line)',
          color: 'var(--fg-1)',
          padding: '4px 10px',
          'font-size': '11px',
          'border-radius': '3px',
          outline: 'none',
          width: '220px',
        }}
      />

      <span class="flex items-center gap-1.5">
        <span
          class="rounded-full"
          style={{
            width: '6px',
            height: '6px',
            background: pulse() ? 'var(--green)' : 'var(--bg-3)',
            'box-shadow': pulse() ? '0 0 8px var(--green)' : 'none',
            transition: 'background 200ms',
          }}
        />
        <span style={{ color: 'var(--fg-2)' }}>live</span>
      </span>
    </header>
  )
}

function Divider() {
  return <span style={{ color: 'var(--fg-4)' }}>|</span>
}
