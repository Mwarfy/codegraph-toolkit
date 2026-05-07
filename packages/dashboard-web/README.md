# @liby-tools/dashboard-web

Dense cockpit UI for `codegraph-toolkit`. Pairs with
`@liby-tools/dashboard-server` to render the live graph, tensions,
runtime timings, and agent transparency in a single screen.

## What you see

```
┌────────────────────────────────────────┬──────────────────────┐
│                                        │ Tensions / Diff /    │
│                                        │ Focus    (priority)  │
│         Sigma graph                    ├──────────────────────┤
│         (forceAtlas2)                  │ Transparency agent   │
│         tinted by tension              │   ├ stats            │
│                                        │   ├ hook timeline    │
│                                        │   └ live feed        │
│                                        ├───────────┬──────────┤
│                                        │ Runtime   │ Commits  │
└────────────────────────────────────────┴───────────┴──────────┘
                       ▼ Time-travel · LIVE / PINNED
```

- **Graph** — every file/directory in the snapshot. Color = tension kind
  (red=cycle, gray=orphan, purple=barrel-low, amber=long-fn, green=clean).
  Click a node → focus mode.
- **Tensions** (default top-right) — orphans, cycles, low-value barrels,
  long functions, drift signals, with a one-line "test rapide" hint each.
- **Diff** (top-right when pinned) — what changed between the pinned
  snapshot and the previous one in chronological order. Nodes added,
  edges added, tensions delta.
- **Focus** (top-right when a node is clicked) — drill-down: importers,
  imports, co-change pairs, long fns, todos, env vars, drift signals,
  truth-point status. Click a partner to navigate.
- **Transparency** — totals (tokens injected / dedup hits / saved),
  hooks observed, 5-minute horizontal timeline of hook fires (PRE blue
  top track, POST green bottom track, faded = dedup), live feed (newest
  first).
- **Runtime** — top 12 detectors by p95 latency. Lightning ⚡ marks
  detectors with λ_lyap > 5 (cliff-prone, data-dependent).
- **Commits** — last 20 with relative age and files-changed count.
- **Time-travel bar** (bottom) — one dot per historical snapshot.
  Click to pin the graph at that point; click again to unpin and
  return to LIVE.

## Stack

- **SolidJS + Vite** — fine-grained reactive updates, ~50 KB gzipped
- **Sigma + graphology + forceAtlas2** — WebGL graph, scales to 5k+ nodes
- **Tailwind** — dense utility CSS, no design-system imposition
- **Native WebSocket** — bidirectional, no socket.io overhead

## Run it

In dev (with HMR + proxy to a running `dashboard-server`):

```bash
# terminal 1
npx @liby-tools/dashboard-server --root . --port 4242

# terminal 2
cd packages/dashboard-web
npx vite          # → http://127.0.0.1:5173
```

In prod:

```bash
cd packages/dashboard-web
npx vite build
node ../dashboard-server/dist/index.js \
  --root /path/to/project \
  --web-static dist
```

The server auto-discovers a sibling `dashboard-web/dist` if it lives
at `packages/dashboard-web/dist` next to the server build.

## Customizing

- **Graph layout**: tweak `runLayout()` in `src/components/Graph.tsx`
  (forceAtlas2 settings).
- **Tension colors**: `TENSION_COLORS` map in the same file.
- **Time window for hook timeline**: `WINDOW_MS` in
  `src/components/CallTimeline.tsx`.
- **API base URL**: `vite.config.ts` proxy + `WsClient` URL in
  `src/lib/ws.ts`.

## Why SolidJS, not React

When a single telemetry record arrives over WS, we want only that
list item to re-render — not the whole transparency panel. Solid's
signals do that natively. With React we'd be sprinkling `memo` and
`useMemo` everywhere for the same result.
