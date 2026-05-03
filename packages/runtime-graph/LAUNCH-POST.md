---
title: I built an OSS runtime observability framework that uses 6 mathematical disciplines to detect architectural drift
published: false
description: Datadog and JFrog give you dashboards. We need something that COMPOSES rules across statistical and topological disciplines. So I built it. 1500-line OSS toolkit, MIT.
tags: opentelemetry, observability, oss, datalog
---

> **TL;DR** — `@liby-tools/runtime-graph` captures the actual execution graph of a Node.js app via OpenTelemetry, projects it to canonical datalog facts, and joins them with static facts from a sister package (`@liby-tools/codegraph`) to surface architectural drift, dead routes, hidden modules, and chaotic latency — using 6 mathematical disciplines (Granger, Hamming, Newman-Girvan, Lyapunov, Information Bottleneck, TDA persistence). The OSS alternative to Datadog Live Code Coverage / JFrog X-Ray, with composable rules instead of black-box dashboards. MIT, alpha.4 on npm today.

## The problem

After 3 weeks debugging why a self-improvement loop in my Sentinel project (YouTube Shorts auto-publisher) had silently broken — 14 days of zero published videos despite "all green" CI — I realized something brutal :

**Static analysis alone doesn't tell you what's wired up. Runtime metrics alone don't tell you what's drifted from the design.**

Datadog tells you a route is slow. It can't tell you the route was MEANT to call a function that's been silently dead-coded since the last refactor. JFrog X-Ray tells you a function isn't called in production. It can't tell you that's because the import edge was supposed to go through an event bus and the event was never re-emitted after a rename.

Every APM I tried gave me a dashboard. None of them gave me a **query language** that could answer questions like : *"is there a file that BOTH Granger-causes another file at the commit timescale AND at the runtime event timescale?"*

That question turns out to be the right one when you want to detect REAL architectural couplings vs. coincidence.

## The approach : datalog as the join layer

I split the problem into 3 layers :

```
Layer 1 — capture
  OpenTelemetry auto-instrumentations (HTTP, pg, redis, MongoDB)
  + a custom span aggregator → 8 canonical fact relations

Layer 2 — discipline metrics  
  Pure functions on facts → derived facts (math at this layer, no I/O)
  6 disciplines : Hamming, Information Bottleneck, Newman-Girvan,
  Lyapunov (scalar + time-series), Granger, TDA persistence

Layer 3 — datalog rules
  Declarative queries that JOIN runtime facts with static facts
  from @liby-tools/codegraph (call graph, AST-derived). Answers
  questions no single layer can answer alone.
```

The key insight : **the whole thing is just relations and rules**. There's no opinionated dashboard, no special-cased "service map" view. Add a new fact relation, write a new rule that joins it with existing relations, you get a new alert. Compose disciplines like LEGO.

## Concrete : 6 disciplines, 4 layers, 1 query language

### Layer 1 — facts (capture)

```ts
import { attachRuntimeCapture, aggregateSpans } from '@liby-tools/runtime-graph'

const capture = attachRuntimeCapture({ projectRoot: __dirname })
// ... run your app under load, or `npm test`, or your test driver ...
const spans = await capture.stop()
const snapshot = aggregateSpans(spans, { projectRoot: __dirname, runMeta })
```

Out comes 8 fact relations like `HttpRouteHit(method, path, status, count, p95LatencyMs)`, `DbQueryExecuted(table, op, count, lastAtUnix)`, `CallEdgeRuntime(fromFile, fromFn, toFile, toFn, count)`.

### Layer 2 — disciplines (math)

Each is a pure function from a snapshot to a derived fact relation. I'll just show 2 :

**Granger causality runtime** (Clive Granger 1969, Nobel Economics 2003) :

```
For each pair of bucketed time series (A, B):
  excess = P(B spike at t+1 | A spike at t) - P(B spike at t+1)
  emit if excess >= 0.15 and observations >= 3
```

Translated : "if A's request rate spikes, does B's spike one second later, beyond the baseline rate of B's spikes?" If yes, A drives B. This catches event chains : `/api/orders` → INSERT into orders table → publish order.created event, all visible as a directed Granger arrow at lag-1.

**TDA Persistent Homology dim-0** (Edelsbrunner-Letscher-Zomorodian 2002) :

```
Sort runtime call edges by count desc.  
Process via union-find:
  - 2 singletons merge → form cluster, born at current count
  - singleton + cluster merge → singleton dies (insignificant)
  - 2 real clusters merge → younger cluster dies
    persistence = birth - death > 0 → emit
```

Translated : "what file groups in the call graph have stronger internal connections than bridges to the rest?" Long persistence = robust functional module. The unique value : it identifies clusters that don't match your `packages/` folder layout — hidden modules that should probably be made explicit.

### Layer 3 — datalog rules

Now the fun part :

```datalog
// runtime-only rule
RuntimeGrangerHigh(D, F, Obs, Excess) :-
  GrangerRuntime(D, F, Obs, Excess, _),
  Excess >= 200,
  Obs >= 5.

// composite : runtime AND static
GrangerCrossValidated(D, F, RuntimeExcess, StaticExcess) :-
  GrangerRuntimeFile(D, F, _, RuntimeExcess),
  GrangerCausality(D, F, _, StaticExcess),
  RuntimeExcess >= 200,
  StaticExcess >= 200.
```

The second rule is the one no APM can write. It says : "alert me when file A drives file B at BOTH the commit timescale (Granger over git history) AND the runtime event timescale (Granger over current run buckets)". That's a coupling verified across two independent scales of time. High-confidence signal that an architectural change is needed.

## What ships in alpha.4 (today)

**6 disciplines runtime** :
- `Hamming distance` static↔runtime — drift between declared and executed call graph
- `Information Bottleneck` — chokepoints (high inflow, low outflow)
- `Newman-Girvan modularity` — community structure quality
- `Lyapunov scalar` (γ.1) + `Lyapunov 1D time-series` (γ.2 Rosenstein) — local chaos vs time-evolution chaos
- `Granger causality` — directional lag-1 coupling
- `TDA Persistent Homology dim-0` — robust runtime clusters

**4 base rules + 3 composite rules** that join runtime × static, including :
- `COMPOSITE_HUB_BOTTLENECK` — static fan-in ≥ 20 AND runtime IB ≥ 0.85
- `COMPOSITE_CYCLE_RUNTIME_CONFIRMED` — static cycle AND runtime bidirectional edges observed
- `COMPOSITE_GRANGER_CROSS_VALIDATED` — both timescales agree

**3 drivers** to provoke runtime activity :
- `synthetic` — curl HTTP routes from `EntryPoint` static facts
- `replay-tests` — run vitest/jest/mocha under OTel attach (high test coverage = high facts coverage)
- `chaos` — inject malformed payloads to exercise error paths

**592/592 unit tests** passing on the toolkit, including pure-math tests on the 6 disciplines (deterministic on synthetic snapshots).

## Why open-source it

Two reasons.

First : I don't think runtime observability should be a moat. The math is in the public domain (Tishby, Newman, Granger, Edelsbrunner all published). The graph topology theory is undergrad-level. Datadog charges per host because they sell pretty dashboards, not because the math is hard. Strip the dashboards and you have a 1500-line core.

Second : the only way this becomes useful is if other projects bring different facts. I'm running it on Sentinel, which is a YouTube Shorts pipeline. Someone else can run it on a Next.js SaaS or a Rust API or a Django app. As long as the facts schema holds, the rules transfer. The economics of the toolkit improve with N consumers — exactly the wrong shape for a SaaS.

## Try it

```bash
npm install --save-dev @liby-tools/runtime-graph @liby-tools/codegraph @liby-tools/datalog

# 1. Static analysis
npx codegraph analyze

# 2. Capture runtime  
npx liby-runtime-graph run --duration 60 --base-url http://localhost:3000

# 3. Read alerts (also in .codegraph/facts-runtime/)
```

Source : [github.com/Mwarfy/codegraph-toolkit](https://github.com/Mwarfy/codegraph-toolkit)

Feedback / issues / PRs welcome — particularly on : (a) frameworks I haven't adapted yet (Fastify, Hono, NestJS), (b) factsupport for ORMs beyond Drizzle/Prisma, (c) datalog rules you find useful that I missed.

## What's next : γ.3

- **TDA dim-1** : cycle persistence (when does a topological loop appear and disappear in the call graph filtration?)
- **Bayesian co-execution** : conditional probability of "if symbol A is touched in run N, what's the prob symbol B is also touched?"
- **Multi-lag Granger** : extend lag from 1 to k, find best lag automatically per pair

The plan is to ship a stable 1.0 once γ.3 lands and a few external projects validate the facts schema doesn't shift under their workloads.

---

*MIT licensed. No telemetry, no phone-home, no SaaS upgrade path. Just code that runs locally on your machine and writes TSV files.*
