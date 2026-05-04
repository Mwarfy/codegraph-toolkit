# runtime-graph demo — ground-truth fixture

Minimal ESM Node.js app that exists for **one job**: prove that
`@liby-tools/runtime-graph`'s auto-bootstrap correctly captures HTTP spans
on a `"type": "module"` project.

## Why this exists

OpenTelemetry's auto-instrumentation patches `require()` calls via
`require-in-the-middle`. On ESM projects (`"type": "module"`), modules are
loaded via `import` which **bypasses `require()`** — so naive bootstrap
captures **0 spans**. This was the silent failure mode of Sentinel's
runtime-graph probe (3 runs, all empty captures).

The fix : auto-bootstrap registers `import-in-the-middle/hook.mjs` via
`module.register()` BEFORE attaching OTel, AND it must be loaded with
`--import` (not `--require`) so the hook activates before any ESM imports
in the target.

This demo is the regression canary : `./run.sh` runs the app under bootstrap
and asserts exact expected facts. If a future toolkit change breaks ESM
capture, this fixture fails immediately.

## Usage

```bash
# From toolkit root :
npm install
cd packages/runtime-graph && npm run build
./examples/runtime-graph-demo/run.sh
```

Expected output : `✓ tous les asserts passent` + facts table with
`HttpRouteHit : 3 lignes` and `totalSpans ≥ 3`.

## Expected facts

| Relation | Lines | Why |
|---|---|---|
| `HttpRouteHit` | 3 | One per route exercised (`/healthz`, `/users`, `/products`) |
| `RuntimeRunMeta` | 1 | Always written, even on 0 captures |
| `SymbolTouchedRuntime` | 0 | Demo has no app code attribution (raw `node:http` only) |
| `CallEdgeRuntime` | 0 | No cross-function calls instrumented |
| `DbQueryExecuted` | 0 | No DB |
| `RedisOpExecuted` | 0 | No Redis |
| `EventEmittedAtRuntime` | 0 | No event bus |

`totalSpans` ≥ 3 because each route emits both a server span (incoming) and
a client span (the self-request via `http.get`).

## How to consume runtime-graph in a real ESM project

```bash
NODE_OPTIONS="--import file:///abs/path/to/dist/capture/auto-bootstrap.js" \
  LIBY_RUNTIME_PROJECT_ROOT="$(pwd)" \
  LIBY_RUNTIME_FACTS_OUT="$(pwd)/.codegraph/facts-runtime" \
  node your-app.mjs
```

CJS projects can use `--require` (legacy path) ; ESM **must** use `--import`.
