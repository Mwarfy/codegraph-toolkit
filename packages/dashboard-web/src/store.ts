// ADR-032 — consumer du contrat HTTP via ./lib/api.js. Drift de shape
// côté dashboard-server → undefined silencieux dans les composants Solid.
import { createSignal, createResource } from 'solid-js'
import type { SnapshotPayload, TelemetryRecord } from './lib/api.js'
import { api } from './lib/api.js'
import { WsClient } from './lib/ws.js'

const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
const ws = new WsClient(wsUrl)

// Pin mode: when set, the cosmos shows a historical snapshot. Live WS
// snapshot:updated events still arrive but don't trigger a refetch — the
// user explicitly chose a frozen point in time. Driven by TimeTravelBar.
const [pinnedFile, setPinnedFile] = createSignal<string | null>(null)

// Header search input. Components dim/exclude nodes that don't match.
const [filterPattern, setFilterPattern] = createSignal<string>('')

// Live "touched" tracking: when a hook fires, we mark the target file so
// the cosmos can pulse it as the active edit. Cleared after 8s so the
// ripple doesn't accumulate forever.
const [lastTouchedFile, setLastTouchedFile] = createSignal<string | null>(null)
let touchTimer: number | null = null
function markTouched(file: string): void {
  setLastTouchedFile(file)
  if (touchTimer) clearTimeout(touchTimer)
  touchTimer = window.setTimeout(() => setLastTouchedFile(null), 8000)
}

// Payload viewer state — what's open in the modal overlay.
type ViewerState =
  | { kind: 'closed' }
  | { kind: 'payload'; hash: string; meta: { hook: string; event: string; file: string; ts: number } }
  | { kind: 'boot' }
const [viewer, setViewer] = createSignal<ViewerState>({ kind: 'closed' })

// IMPORTANT: createResource doesn't fire the fetcher when the source is
// falsy (null/undefined/false) — so passing `pinnedFile` directly meant
// the LIVE mode (pin = null) never triggered an initial fetch. Wrap in
// a sentinel string so the source is always truthy and reactive.
const LIVE_SENTINEL = '__LIVE__'
const [snapshot, { refetch: refetchSnapshot }] = createResource(
  () => pinnedFile() ?? LIVE_SENTINEL,
  async (key): Promise<SnapshotPayload> => {
    return key === LIVE_SENTINEL ? api.snapshot() : api.snapshotByFile(key)
  },
)

const [telemetrySummary, { refetch: refetchTelemetrySummary }] = createResource(() => api.telemetrySummary())
const [snapshotsList, { refetch: refetchSnapshotsList }] = createResource(() => api.snapshots())

// Live telemetry feed: prepend incoming records, capped at 100.
const [liveTelemetry, setLiveTelemetry] = createSignal<TelemetryRecord[]>([])

// Hydrate the live feed from the persisted JSONL on first mount.
void api.telemetry(50).then((r) => setLiveTelemetry(r.records.slice().reverse()))

ws.on((evt) => {
  if (evt.type === 'snapshot:updated') {
    void refetchSnapshotsList()
    if (pinnedFile() === null) {
      void refetchSnapshot()
    }
    return
  }
  if (evt.type === 'telemetry:appended') {
    const rec = evt.record as unknown as TelemetryRecord
    setLiveTelemetry((prev) => [rec, ...prev].slice(0, 100))
    void refetchTelemetrySummary()
    if (typeof rec.file === 'string') markTouched(rec.file)
    return
  }
})

ws.start()

export const store = {
  snapshot,
  telemetrySummary,
  snapshotsList,
  liveTelemetry,
  pinnedFile,
  setPinnedFile,
  filterPattern,
  setFilterPattern,
  lastTouchedFile,
  viewer,
  setViewer,
  refetch: {
    snapshot: refetchSnapshot,
    telemetrySummary: refetchTelemetrySummary,
    snapshotsList: refetchSnapshotsList,
  },
}
