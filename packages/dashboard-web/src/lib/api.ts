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
  payloadHash?: string
}

export interface BootContext {
  file: string
  mtime: number
  bytes: number
  tokensApprox: number
  content: string
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

export interface SnapshotEntry {
  file: string
  ts: string
  sha: string
  isoDate: string
  bytes: number
}

export interface NodeDetails {
  id: string
  type?: string
  status?: string
  tags?: string[]
  importers: Array<{ from: string; type?: string }>
  imports: Array<{ to: string; type?: string }>
  truthPoint?: { reason?: string }
  longFunctions: Array<{ name: string; lines: number }>
  todos: Array<{ line: number; text: string }>
  envVars: string[]
  driftSignals: Array<{ kind: string; detail: string }>
  coChange: Array<{ partner: string; rate: number; sharedCommits: number }>
}

export interface DiffResult {
  from: { file: string; commit?: string; generatedAt?: string }
  to: { file: string; commit?: string; generatedAt?: string }
  nodes: { added: string[]; removed: string[]; commonCount: number }
  edges: { added: string[]; removed: string[]; commonCount: number }
  tensions: {
    cyclesAdded: number
    cyclesRemoved: number
    barrelsLowAdded: number
    barrelsLowRemoved: number
    longFunctionsAdded: number
    longFunctionsRemoved: number
  }
}

export const api = {
  status: () => getJson<{ ok: boolean; rootDir: string; snapshotLoaded: boolean; wsClients: number }>('/api/status'),
  snapshotMeta: () => getJson<SnapshotMeta>('/api/snapshot/meta'),
  snapshot: () => getJson<SnapshotPayload>('/api/snapshot'),
  snapshotByFile: (file: string) => getJson<SnapshotPayload>(`/api/snapshot?file=${encodeURIComponent(file)}`),
  snapshots: () => getJson<{ count: number; snapshots: SnapshotEntry[] }>('/api/snapshots'),
  diff: (from: string, to: string) =>
    getJson<DiffResult>(`/api/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  node: (id: string) => getJson<NodeDetails>(`/api/node?id=${encodeURIComponent(id)}`),
  hookPayload: async (hash: string): Promise<string> => {
    const r = await fetch(`/api/hook-payload?hash=${encodeURIComponent(hash)}`)
    if (!r.ok) throw new Error(`payload ${hash} not found`)
    return r.text()
  },
  bootContext: () => getJson<BootContext>('/api/boot-context'),
  tensions: () => getJson<{ count: number; tensions: Tension[] }>('/api/tensions'),
  telemetry: (limit = 200) => getJson<{ count: number; records: TelemetryRecord[] }>(`/api/telemetry?limit=${limit}`),
  telemetrySummary: () => getJson<TelemetrySummary>('/api/telemetry/summary'),
  runtimeTimings: () => getJson<{ count: number; timings: RuntimeTiming[] }>('/api/runtime/timings'),
  commits: (limit = 30) => getJson<{ count: number; commits: Commit[] }>(`/api/commits?limit=${limit}`),
}
