# @liby-tools/runtime-graph

> **Phase α (alpha.1)** — runtime observability framework with datalog query language.
> The OSS alternative to Datadog Live Code Coverage / JFrog X-Ray, with composable
> mathematical rules instead of black-box dashboards.

## What it does

Captures the **actual execution graph** of a Node.js app via OpenTelemetry auto-instrumentation,
projects it to canonical datalog facts, then joins with static facts from
[`@liby-tools/codegraph`](../codegraph/) to surface :

- **DEAD_HANDLER** — exported function never invoked at runtime (dead wiring)
- **DEAD_ROUTE** — HTTP route declared in code but received 0 requests
- **RUNTIME_DRIFT** — static call graph references symbol but runtime never touches it
- **HOT_PATH_UNTESTED** — high-traffic function without test coverage
- **STALE_QUERY** — table with declared writers but no DB activity during run

## Why datalog ?

Because rules are **composable across disciplines**. Phase γ will port the 11 mathematical
disciplines from codegraph statique (Shannon, Newman-Girvan, Lyapunov, TDA persistence, etc.)
to runtime facts — joining static × runtime in queries no APM does today.

## Phase α — what's shipping

```
@liby-tools/runtime-graph (alpha.1)
├── 7 facts canoniques
│   ├── SymbolTouchedRuntime (file, fn, count, p95LatencyMs)
│   ├── HttpRouteHit (method, path, status, count, p95LatencyMs)
│   ├── DbQueryExecuted (table, op, count, lastAtUnix)
│   ├── RedisOpExecuted (op, keyPattern, count)
│   ├── EventEmittedAtRuntime (type, count, lastAtUnix)
│   ├── CallEdgeRuntime (fromFile, fromFn, toFile, toFn, count)
│   └── RuntimeRunMeta (driver, startedAtUnix, durationMs, totalSpans)
├── 5 datalog rules cibles
│   ├── runtime-dead-handler.dl
│   ├── runtime-dead-route.dl
│   ├── runtime-drift.dl
│   ├── runtime-hot-path-untested.dl
│   └── runtime-stale-query.dl
├── 1 driver (β ajoutera replay-har, chaos, shadow-traffic)
│   └── synthetic — curl HTTP routes from EntryPoint statique
└── CLI : liby-runtime-graph run|check
```

## Install

```bash
npm install --save-dev @liby-tools/runtime-graph
```

Peer-resolves `@liby-tools/datalog` (rule runner) and `@liby-tools/codegraph` (static
facts producer) — install both in the consuming project.

## Quick start

```bash
# 1. Static codegraph (produces .codegraph/facts/)
npx codegraph analyze

# 2. Start your app with OTel SDK active
#    In Phase α : the app must instantiate `attachRuntimeCapture()` itself,
#    OR expose the OTel SDK init via NODE_OPTIONS bootstrap.
node app.js &

# 3. Run runtime capture + rules
npx liby-runtime-graph run --duration 300 --base-url http://localhost:3000

# 4. Read alerts
# (printed inline, also available as TSV in .codegraph/facts-runtime/)
```

## Library usage

```ts
import {
  attachRuntimeCapture,
  aggregateSpans,
  exportFactsRuntime,
} from '@liby-tools/runtime-graph'

// Inside your app boot :
const capture = attachRuntimeCapture({ projectRoot: __dirname })

// ... do work, run tests, accept traffic ...

// At shutdown / end of test :
const spans = await capture.stop()
const snapshot = aggregateSpans(spans, {
  projectRoot: __dirname,
  runMeta: { driver: 'manual', startedAtUnix: 0, durationMs: 0, totalSpans: spans.length },
})
await exportFactsRuntime(snapshot, { outDir: '.codegraph/facts-runtime' })
```

## Roadmap

| Phase | Scope | ETA |
|---|---|---|
| **α (now)** | OTel attach + 7 facts + 5 rules + synthetic driver + CLI | — |
| **β** | Multi-framework adapters (Express/Fastify/NestJS), multi-DB (Mongo/Kafka), config-driven | 6-8 weeks |
| **γ** | 11 disciplines mathématiques runtime (TDA, Information Bottleneck, Lyapunov, etc.) | 8-12 weeks |

## License

MIT
