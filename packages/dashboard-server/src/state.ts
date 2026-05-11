import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { loadStoredSnapshot, unwrapSnapshot } from '@liby-tools/codegraph/snapshot-loader'

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

// ADR-027 — délégué au loader unifié (`@liby-tools/codegraph/snapshot-loader`).
// `snapshot-live.json` (watcher artifact pré-Phase-2) reste géré en priorité
// pour les checkouts qui tournent encore avec une ancienne version du
// watcher ; sinon le loader retourne v2 ou legacy.
export async function loadSnapshot(state: DashboardState): Promise<boolean> {
  // Priority : snapshot-live.json si présent (live watcher)
  const live = path.join(state.codegraphDir, 'snapshot-live.json')
  try {
    const stat = await fs.stat(live)
    if (live === state.snapshotPath && stat.mtimeMs === state.snapshotMtime) {
      return false
    }
    const raw = await fs.readFile(live, 'utf-8')
    const parsed = JSON.parse(raw)
    state.snapshotPath = live
    state.snapshotMtime = stat.mtimeMs
    // Délègue à `unwrapSnapshot` (helper canonique snapshot-loader) :
    // accepte tout wrapper listé dans `WRAPPER_VERSIONS` + fallback plat
    // pré-v2. Bumper le format demande de toucher snapshot-loader.ts seul.
    state.snapshotData = unwrapSnapshot(parsed)
    return true
  } catch {
    /* live absent → loader unifié */
  }

  const loaded = await loadStoredSnapshot(state.codegraphDir)
  if (!loaded) return false
  const stat = await fs.stat(loaded.source)
  if (loaded.source === state.snapshotPath && stat.mtimeMs === state.snapshotMtime) {
    return false
  }
  state.snapshotPath = loaded.source
  state.snapshotMtime = stat.mtimeMs
  state.snapshotData = loaded.payload
  return true
}
