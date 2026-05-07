# @liby-tools/dashboard-server

Live cockpit server for `codegraph-toolkit`. Exposes the agent-facing
`.codegraph/` artifacts (snapshots, tensions, runtime timings, hook
telemetry, git history) over REST + WebSocket so the bundled
`@liby-tools/dashboard-web` (or any other consumer) can render them
in real time.

## What it does

Watches `.codegraph/` for changes — `snapshot-live.json`, any
`snapshot-*.json` written by the analyzer, `hook-telemetry.jsonl`
appended by the Claude Code hooks — and pushes a delta over WebSocket
on every update. The graph in the front re-renders incrementally; the
agent transparency feed appends in real time as `PreToolUse` /
`PostToolUse` hooks fire.

## Endpoints

```
GET  /api/status                  — health + ws client count
GET  /api/snapshot                — current snapshot (live or latest)
GET  /api/snapshot?file=<name>    — load a historical snapshot by name
GET  /api/snapshot/meta           — counts, source path, mtime
GET  /api/snapshots               — list all snapshot-<ts>-<sha>.json
GET  /api/tensions                — orphans, cycles, low-value barrels, long fns, drift
GET  /api/telemetry?limit=N       — last N hook injection records
GET  /api/telemetry/summary       — totals + per-hook + per-file aggregates
GET  /api/runtime/timings         — DetectorTiming.facts parsed
GET  /api/runtime/diff            — current vs baseline DetectorTiming
GET  /api/commits?limit=N         — git log with shortstat
GET  /api/diff?from=A&to=B        — node/edge/tension delta between two snapshots
GET  /api/node?id=<file>          — drill-down for a single node (importers, imports, co-change…)
GET  /ws                          — WebSocket: snapshot:updated · telemetry:appended
```

All endpoints serve JSON. Path traversal is blocked on file params:
only `.codegraph/snapshot-*.json` resolves.

## Run it

```bash
# stand-alone (REST + WS only)
npx @liby-tools/dashboard-server --root /path/to/your/project --port 4242

# with the bundled web UI
npx @liby-tools/dashboard-server \
  --root /path/to/your/project \
  --port 4242 \
  --web-static node_modules/@liby-tools/dashboard-web/dist
```

The server auto-discovers a sibling `dashboard-web/dist` if no
`--web-static` is provided — installing both packages and running the
server is enough.

## Hook telemetry contract

The transparency panel reads `.codegraph/hook-telemetry.jsonl`.
Each line is one record written by `scripts/git-hooks/adr-hook.sh`
(PreToolUse) or `scripts/git-hooks/codegraph-feedback.sh` (PostToolUse):

```json
{
  "ts": 1778139561,
  "hook": "codegraph-feedback",
  "event": "PostToolUse",
  "file": "packages/codegraph/src/core/types.ts",
  "bytes": 310,
  "tokensApprox": 77,
  "dedupHit": false,
  "dedupAgeSec": null
}
```

`tokensApprox = bytes / 4` — rough but consistent at this scale.
The hook never fails on a write error — best-effort logging only.

## Architecture

```
.codegraph/                        REST routes
  snapshot-*.json     ─────────►  /api/snapshot[?file=…]
  snapshot-live.json              /api/snapshot/meta
  hook-telemetry.jsonl            /api/telemetry[/summary]
  facts-self-runtime/             /api/runtime/timings
  ...                             /api/runtime/diff
                                  /api/diff
                                  /api/node
                                  /api/snapshots
fs.watch  ─►  WsHub  ─►  /ws  ─►  client (re-render)
```

No background analyze. The server is a thin reader — analysis happens
in `@liby-tools/codegraph` (manual `analyze` or via the watcher) and
this server projects what's on disk.

## Why a separate package

`@liby-tools/codegraph-mcp` exposes the same data to *agents*. This
package exposes it to *humans*. Different release cadences, different
audiences, different surface — but the same `.codegraph/` source of
truth, by design.
