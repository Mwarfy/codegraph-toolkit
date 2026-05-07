import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export interface DashboardState {
  rootDir: string
  codegraphDir: string
  snapshotPath: string | null
  snapshotMtime: number
  snapshotData: unknown | null
}

export function createState(rootDir: string): DashboardState {
  return {
    rootDir,
    codegraphDir: path.join(rootDir, '.codegraph'),
    snapshotPath: null,
    snapshotMtime: 0,
    snapshotData: null,
  }
}

/**
 * Pick the most recent snapshot to consume. Prefer snapshot-live.json
 * (written by the watcher) when present — that's the one updating in
 * real-time as the agent edits. Fall back to the latest commit-pinned
 * snapshot-<ts>-<sha>.json when no watcher is running.
 */
export async function resolveSnapshotFile(codegraphDir: string): Promise<string | null> {
  const live = path.join(codegraphDir, 'snapshot-live.json')
  try {
    await fs.access(live)
    return live
  } catch {
    // No snapshot-live.json — watcher isn't running. Falls through to
    // the historical snapshot resolution below; this is the expected
    // path on a cold-start.
  }

  let entries: string[]
  try {
    entries = await fs.readdir(codegraphDir)
  } catch {
    return null
  }
  const snapshots = entries
    .filter((f) => f.startsWith('snapshot-') && f.endsWith('.json') && f !== 'snapshot-live.json')
    .sort()
  if (snapshots.length === 0) return null
  return path.join(codegraphDir, snapshots[snapshots.length - 1])
}

export async function loadSnapshot(state: DashboardState): Promise<boolean> {
  const file = await resolveSnapshotFile(state.codegraphDir)
  if (!file) return false
  const stat = await fs.stat(file)
  if (file === state.snapshotPath && stat.mtimeMs === state.snapshotMtime) {
    return false
  }
  const text = await fs.readFile(file, 'utf-8')
  state.snapshotPath = file
  state.snapshotMtime = stat.mtimeMs
  state.snapshotData = JSON.parse(text)
  return true
}
