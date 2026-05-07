import { createSignal, createResource } from 'solid-js'
import type { TelemetryRecord } from './lib/api.js'
import { api } from './lib/api.js'
import { WsClient } from './lib/ws.js'

const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
const ws = new WsClient(wsUrl)

const [snapshot, { refetch: refetchSnapshot }] = createResource(() => api.snapshot())
const [tensions, { refetch: refetchTensions }] = createResource(() => api.tensions())
const [telemetrySummary, { refetch: refetchTelemetrySummary }] = createResource(() => api.telemetrySummary())
const [runtime, { refetch: refetchRuntime }] = createResource(() => api.runtimeTimings())
const [commits, { refetch: refetchCommits }] = createResource(() => api.commits(20))

// Live telemetry feed: prepend incoming records, capped at 100.
const [liveTelemetry, setLiveTelemetry] = createSignal<TelemetryRecord[]>([])

// Hydrate the live feed from the persisted JSONL on first mount.
void api.telemetry(50).then((r) => setLiveTelemetry(r.records.slice().reverse()))

ws.on((evt) => {
  if (evt.type === 'snapshot:updated') {
    void refetchSnapshot()
    void refetchTensions()
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
  liveTelemetry,
  refetch: {
    snapshot: refetchSnapshot,
    tensions: refetchTensions,
    telemetrySummary: refetchTelemetrySummary,
    runtime: refetchRuntime,
    commits: refetchCommits,
  },
}
