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

| Phase | Scope | Status |
|---|---|---|
| **α** | OTel attach + 7 facts + 5 rules + synthetic driver + CLI | ✅ shipped (alpha.1) |
| **β** | replay-tests + chaos + Express + MongoDB + config-driven | ✅ shipped (alpha.2) |
| **γ (now)** | 4 mathematical disciplines runtime (Hamming, IB, Newman-Girvan, Lyapunov) + composites cross-statique×runtime | ✅ shipped (alpha.3) |
| **γ.2** | TDA persistence, Granger causality, Bayesian co-execution + time-series Lyapunov | future |

## Phase γ additions (alpha.3)

**4 disciplines mathématiques runtime** projetées en facts datalog :

- **Hamming distance** statique↔runtime — quantifie le drift entre code
  déclaré et code exécuté. `HammingStaticRuntime(distancePermille, ...)`.
- **Information Bottleneck** — score 0..1 par symbol détectant les
  chokepoints (high inflow, low outflow). `IBScoreRuntime(file, fn, inflow, outflow, scorePermille)`.
- **Newman-Girvan modularity** — Q ∈ [-1,1] global + per-file. Mesure
  si les communautés (= files) sont bien définies au runtime. `NgGlobalQ(qPermille)`, `NgFileQ(file, qPermille, n)`.
- **Lyapunov approximation** — log(p95+1) sur hot symbols. Approxime le
  chaos local. `LyapunovRuntime(file, fn, p95, count, lambdaPermille)`.

**4 rules runtime** + **2 composite rules** (statique × runtime) :

| Rule | Signal |
|---|---|
| `DRIFT_HIGH` | Hamming > 0.30 sur graph total ≥ 50 edges |
| `BOTTLENECK` | IB score > 0.85 + inflow ≥ 5 |
| `MODULARITY_COLLAPSE` | Q < 0.30 + ≥ 10 files participating |
| `CHAOTIC_LATENCY` | log(p95) > 6.9 (= p95 > 1s) sur hot symbol |
| **`COMPOSITE_HUB_BOTTLENECK`** | Hub statique (fan-in ≥20) **ET** chokepoint runtime (IB > 0.85) |
| **`COMPOSITE_CYCLE_RUNTIME_CONFIRMED`** | Cycle statique **ET** edges bidirectionnels observés runtime |

Les composites sont LE saut qualitatif unique : aucun APM ne calcule
ces intersections. Datalog comme query language permet de les composer
en quelques lignes par discipline.

**16 nouveaux tests unitaires** sur les disciplines (math validée
sur snapshots synthétiques). 50/50 dans runtime-graph, 563/563 toolkit.

## Phase β additions (alpha.2)

- **`replay-tests` driver** — lance la suite de tests existante du projet
  (vitest, jest, mocha) sous OTel SDK pre-attached. Couverture maximale
  sans driver synthetic dédié.
- **`chaos` driver** — error injection ciblée sur les routes HTTP (invalid
  path params, malformed JSON, missing headers, unicode payloads). Exerce
  les error paths que synthetic ne touche pas.
- **Express adapter** — `discoverExpressRoutes(app)` walk `app._router.stack`
  pour lister les routes registered (Express 4 + 5).
- **MongoDB support** — `aggregateSpans` détecte `db.system='mongodb'` +
  `db.mongodb.collection` (en plus du SQL parsing).
- **Config loader** — `liby-runtime.config.ts` declarative au projet :
  `defineConfig({ drivers: [...], capture: {...}, expectedTables: [...] })`.
- **PID sub-dirs bootstrap** — fix critique : npm test parent et node child
  écrivent dans `pid-<N>/` séparés. Le CLI merge tous les sub-dirs.

## License

MIT
