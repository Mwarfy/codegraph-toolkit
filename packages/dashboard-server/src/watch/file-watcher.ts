import { watch } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { DashboardState } from '../state.js'
import { loadSnapshot } from '../state.js'
import type { WsHub } from '../ws-hub.js'

/**
 * Watch .codegraph/ for two signal types:
 *   - snapshot-live.json (or any snapshot-*.json) → graph state changed
 *   - hook-telemetry.jsonl → agent activity (PreToolUse / PostToolUse fired)
 *
 * On change, push an event over WS so the front re-renders incrementally.
 * Reads use mtime debouncing to coalesce rapid bursts (chokidar would be
 * heavier — fs.watch is enough for this use case).
 */
export function startWatcher(state: DashboardState, hub: WsHub): () => void {
  let snapshotDebounce: NodeJS.Timeout | null = null
  let telemetryOffset = 0

  const initTelemetryOffset = async (): Promise<void> => {
    try {
      const stat = await fs.stat(path.join(state.codegraphDir, 'hook-telemetry.jsonl'))
      telemetryOffset = stat.size
    } catch {
      telemetryOffset = 0
    }
  }
  void initTelemetryOffset()

  const watcher = watch(state.codegraphDir, { persistent: true }, (_event, filename) => {
    if (!filename) return

    if (filename.startsWith('snapshot-') && filename.endsWith('.json')) {
      if (snapshotDebounce) clearTimeout(snapshotDebounce)
      snapshotDebounce = setTimeout(() => {
        void loadSnapshot(state).then((changed) => {
          if (changed) {
            hub.broadcast({ type: 'snapshot:updated', ts: Date.now() })
          }
        })
      }, 100)
      return
    }

    if (filename === 'hook-telemetry.jsonl') {
      void readTelemetryDelta()
      return
    }
  })

  const readTelemetryDelta = async (): Promise<void> => {
    const file = path.join(state.codegraphDir, 'hook-telemetry.jsonl')
    let stat
    try {
      stat = await fs.stat(file)
    } catch {
      return
    }
    if (stat.size <= telemetryOffset) {
      // file truncated/rotated — reset
      telemetryOffset = 0
      return
    }
    const fh = await fs.open(file, 'r')
    try {
      const buf = Buffer.alloc(stat.size - telemetryOffset)
      await fh.read(buf, 0, buf.length, telemetryOffset)
      telemetryOffset = stat.size
      const text = buf.toString('utf-8')
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
          const record = JSON.parse(line) as Record<string, unknown>
          hub.broadcast({ type: 'telemetry:appended', ts: Date.now(), record })
        } catch {
          // skip malformed line
        }
      }
    } finally {
      await fh.close()
    }
  }

  return () => watcher.close()
}
