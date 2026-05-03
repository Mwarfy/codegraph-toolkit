# @liby-tools/runtime-graph

> **Phase γ.2 (alpha.4)** — runtime observability framework with datalog query language.
> POC for joining static call graphs with runtime OpenTelemetry data via composable
> rules. **Not** a replacement for Datadog/JFrog — they do APM, this does
> static×runtime correlation. The math labels (Lyapunov, Granger, TDA, IB) are
> heuristics inspired by their references, NOT the rigorous mathematical objects
> (cf. disclaimers dans `src/extractors/*.ts` du package `codegraph`).

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
| **γ.1** | 4 mathematical disciplines runtime (Hamming, IB, Newman-Girvan, Lyapunov) + composites cross-statique×runtime | ✅ shipped (alpha.3) |
| **γ.2 (now)** | Granger causality runtime + true time-series Lyapunov + TDA persistence dim-0 | ✅ shipped (alpha.4) |
| **γ.3** | TDA dim-1 (cycle persistence) + Bayesian co-execution + multi-lag Granger | future |

## Phase γ.2 additions (alpha.4)

**3 new disciplines** built on top of a sparse 1-second time-series infrastructure
(`LatencySeriesFact`) — captures bucket-level event flow within a run window.

- **Granger causality runtime** (1969 econometrics test, ported to runtime).
  For each pair of series (A, B), measures whether A's spike at bucket *t* predicts
  B's spike at bucket *t+1* beyond the marginal P(B). Detects directional coupling
  invisible in static dependencies — e.g., an HTTP route that triggers a delayed
  DB query through an event chain.
  → `GrangerRuntime(driverSeries, followerSeries, observations, excessConditionalX1000, lag)`

- **Time-series Lyapunov** (Rosenstein-Collins-De Luca 1993, 1D version).
  Replaces the γ.1 scalar `λ = log(p95+1)` with a real Lyapunov 1D over the
  bucketed series. Detects time-evolution **instability** — a route oscillating
  50ms↔500ms fires here, while a steady-100ms route does not (γ.1 cannot
  distinguish them).
  → `LyapunovTimeseries(kind, seriesKey, observations, stdDevX1000, lambdaX1000)`

- **TDA Persistent Homology dim-0** (Edelsbrunner-Letscher-Zomorodian 2002).
  Persistent connected components of the runtime call graph under edge-count
  filtration desc. Identifies **robust runtime clusters** — file groups with
  much stronger internal edges than bridges to the rest. Reveals "hidden
  modules" that don't match declared package boundaries.
  → `PersistentComponent(rep, birthCount, deathCount, persistence, size)`

**4 new rules** (3 new, 1 composite) :

| Rule | Signal |
|---|---|
| `RUNTIME_GRANGER_HIGH` | Directional A→B coupling at lag-1, excess ≥ 0.20 + obs ≥ 5 |
| `CHAOTIC_TIMESERIES` | Time-evolution chaos λ_ts ≥ 0.7 (orthogonal to γ.1's "high p95") |
| `RUNTIME_ROBUST_CLUSTER` | Persistent cluster (size ≥ 3, persistence ≥ 50) |
| **`COMPOSITE_GRANGER_CROSS_VALIDATED`** | A→B Granger-cause at BOTH commit lag (static) AND event lag (runtime) — high-confidence directional coupling |

The cross-validated composite is the unique value-add : when static and runtime
Granger agree on the same file pair, it's an architectural coupling verified
across two independent timescales (jours pour les commits, secondes pour les
événements).

## Phase γ.1 additions (alpha.3)

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
