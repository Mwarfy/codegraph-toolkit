import { createSignal, createResource } from 'solid-js'
import type { SnapshotPayload, TelemetryRecord } from './lib/api.js'
import { api } from './lib/api.js'
import { WsClient } from './lib/ws.js'

const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
const ws = new WsClient(wsUrl)

// Pin mode: when set, the graph displays a historical snapshot. Live WS
// snapshot:updated events still arrive but don't trigger a refetch — the
// user explicitly chose a frozen point in time.
const [pinnedFile, setPinnedFile] = createSignal<string | null>(null)

// Focus mode: when set, the right rail shows drill-down details for the
// node. Takes priority over diff/tensions panels.
const [focusedNode, setFocusedNode] = createSignal<string | null>(null)

// Search/filter: when non-empty, the graph dims nodes that don't match
// the pattern. Pure substring (lowercased). Empty string = no filter.
const [filterPattern, setFilterPattern] = createSignal<string>('')

const [snapshot, { refetch: refetchSnapshot }] = createResource(
  pinnedFile,
  async (pinned): Promise<SnapshotPayload> => {
    return pinned ? api.snapshotByFile(pinned) : api.snapshot()
  },
)

const [tensions, { refetch: refetchTensions }] = createResource(() => api.tensions())
const [telemetrySummary, { refetch: refetchTelemetrySummary }] = createResource(() => api.telemetrySummary())
const [runtime, { refetch: refetchRuntime }] = createResource(() => api.runtimeTimings())
const [commits, { refetch: refetchCommits }] = createResource(() => api.commits(20))
const [snapshotsList, { refetch: refetchSnapshotsList }] = createResource(() => api.snapshots())

// Live telemetry feed: prepend incoming records, capped at 100.
const [liveTelemetry, setLiveTelemetry] = createSignal<TelemetryRecord[]>([])

// Hydrate the live feed from the persisted JSONL on first mount.
void api.telemetry(50).then((r) => setLiveTelemetry(r.records.slice().reverse()))

ws.on((evt) => {
  if (evt.type === 'snapshot:updated') {
    // Refresh the historical list (a new commit may have produced a new
    // pinned snapshot file). If we're not pinned, also refresh the live view.
    void refetchSnapshotsList()
    if (pinnedFile() === null) {
      void refetchSnapshot()
      void refetchTensions()
    }
    return
  }
  if (evt.type === 'telemetry:appended') {
    const rec = evt.record as TelemetryRecord
    setLiveTelemetry((prev) => [rec, ...prev].slice(0, 100))
    void refetchTelemetrySummary()
    return
  }
})

ws.start()

export const store = {
  snapshot,
  tensions,
  telemetrySummary,
  runtime,
  commits,
  snapshotsList,
  liveTelemetry,
  pinnedFile,
  setPinnedFile,
  focusedNode,
  setFocusedNode,
  filterPattern,
  setFilterPattern,
  refetch: {
    snapshot: refetchSnapshot,
    tensions: refetchTensions,
    telemetrySummary: refetchTelemetrySummary,
    runtime: refetchRuntime,
    commits: refetchCommits,
    snapshotsList: refetchSnapshotsList,
  },
}
