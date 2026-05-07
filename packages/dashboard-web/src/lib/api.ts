// Thin typed wrappers around the dashboard-server REST API.

export interface SnapshotMeta {
  source: string
  mtime: number
  nodeCount: number
  edgeCount: number
  commit: string | null
}

export interface SnapshotPayload {
  source: string
  mtime: number
  data: {
    nodes: Array<{ id: string; label?: string; type?: string; status?: string; tags?: string[] }>
    edges: Array<{ id: string; from: string; to: string; type?: string }>
    stats?: Record<string, unknown>
  }
}

export interface Tension {
  kind: string
  target: string
  detail: string
  hint: string
}

export interface TelemetryRecord {
  ts: number
  hook: string
  event: string
  file: string
  bytes: number
  tokensApprox: number
  dedupHit: boolean
  dedupAgeSec: number | null
}

export interface TelemetrySummary {
  totalEvents: number
  totalBytes: number
  totalTokensApprox: number
  dedupHits: number
  dedupSavedTokens: number
  byHook: Record<string, { count: number; tokens: number; dedupHits: number }>
  byFile: Array<{ file: string; count: number; tokens: number }>
}

export interface RuntimeTiming {
  detector: string
  runs: number
  meanMs: number
  p95Ms: number
  stdDev: number
  lambda: number
}

export interface Commit {
  sha: string
  shortSha: string
  ts: number
  author: string
  subject: string
  filesChanged: number
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} on ${url}`)
  return (await r.json()) as T
}

export const api = {
  status: () => getJson<{ ok: boolean; rootDir: string; snapshotLoaded: boolean; wsClients: number }>('/api/status'),
  snapshotMeta: () => getJson<SnapshotMeta>('/api/snapshot/meta'),
  snapshot: () => getJson<SnapshotPayload>('/api/snapshot'),
  tensions: () => getJson<{ count: number; tensions: Tension[] }>('/api/tensions'),
  telemetry: (limit = 200) => getJson<{ count: number; records: TelemetryRecord[] }>(`/api/telemetry?limit=${limit}`),
  telemetrySummary: () => getJson<TelemetrySummary>('/api/telemetry/summary'),
  runtimeTimings: () => getJson<{ count: number; timings: RuntimeTiming[] }>('/api/runtime/timings'),
  commits: (limit = 30) => getJson<{ count: number; commits: Commit[] }>(`/api/commits?limit=${limit}`),
}
