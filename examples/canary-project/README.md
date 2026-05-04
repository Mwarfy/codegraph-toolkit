# canary-project — ground-truth fixture for codegraph

Tiny TypeScript project with **deliberately injected violations**, used to
measure codegraph's detection coverage and catch silent regressions in CI.

`./validate.sh` runs `codegraph analyze` then asserts:
1. **20 specific detections** (one assert per discipline class)
2. **Fact coverage threshold** (currently ≥ 50% of 83 fact relations populated)

If a future toolkit change silently disables a detector, this fixture fails
immediately and tells you which signal regressed.

## Current state — 2026-05-04

```
Asserts        : 20 / 20 ✓
Fact coverage  : 51 / 83 (61%)
```

## Detection categories asserted

| Category | Detected | File / pattern |
|---|---|---|
| **Structure** | cycle, hub, orphan, articulation point | `cycle-a/b.ts`, `hub.ts` + 5 consumers, `orphan.ts` |
| **Code quality** | long function (105 LOC), magic numbers, await-in-loop, alloc-in-loop | `long-function.ts`, `magic-await.ts` |
| **Security** | eval call (taint sink), hardcoded secret, weak crypto (md5) | `taint.ts`, `extras.ts`, `crypto-weak.ts` |
| **State machines** | FSM declared (4 states), 1 orphan state (`abandoned`) | `fsm.ts` |
| **Schemas** | SQL table | `sql-schema.sql` |
| **Identity** | OAuth scope literal, env read, truth-point writer+reader | `oauth-scope.ts`, `extras.ts`, `truth-point.ts` |
| **Events** | emit literal type | `events.ts` |
| **Hygiene** | declared-unused dep (`lodash`), boolean param, no bin shebang | `package.json`, `extras.ts` |

## Mathematical disciplines exercised

These are the formules that fire on canary-project:

| Discipline | Fact | Status | Notes |
|---|---|---|---|
| Newman-Girvan modularity | `ModularityScore`, `ImportCommunity` | ✓ | 1 + 26 rows |
| Shannon entropy | `SymbolEntropy` | ✓ | 1 row |
| PageRank / Henry-Kafura | `ModuleCentrality`, `ModuleFanIn` | ✓ | 23 rows each |
| Information Bottleneck (heuristic) | `InformationBottleneck` | ✓ | 18 rows |
| Articulation points (graph theory) | `ArticulationPoint` | ✓ | 3 rows |
| Cyclomatic + cognitive complexity | `FunctionComplexity` | ✓ | 28 rows |
| Hamming similarity | `SignatureNearDuplicate` | ✗ | empty — extractor logic to debug |
| Fiedler eigenvalue (spectral) | `SpectralMetric` | ✗ | needs partitioned graph |
| NCD compression distance | `CompressionDistance` | ✗ | needs structurally-similar files |
| Lyapunov exponent (time series) | `LyapunovMetric` | ✗ | **needs git history** |
| Granger causality | `GrangerCausality` | ✗ | **needs git history** |
| Bayesian co-change | `BayesianCoChange`, `CoChange` | ✗ | **needs git history** |
| TDA persistence (homology) | `PersistentCycle` | ✗ | **needs git history** |
| Fact stability over time | `FactKindStability` | ✗ | **needs git history** |

The 5 marked **needs git history** are time-series disciplines — they read
git log to compute correlations across commits. They can't fire on a
git-less fixture; covering them needs a separate `with-history/` fixture
that initializes a synthetic 10-commit history with controlled file
churn. Tracked as future work.

## Coverage gaps (32 / 83 facts still empty)

```
Git-history-only (7)    : BayesianCoChange, CoChange, CompressionDistance,
                          FactKindStability, GrangerCausality, LyapunovMetric,
                          PersistentCycle
Fixable (15)            : Barrel, BooleanParam (in deeper context),
                          ConstantExpression, CorsConfig, DeadCode,
                          DeprecatedUsage, DriftSignalFact, EmitsConstRef/
                          Dynamic, ListensConstRef/Dynamic, EnvReadWrapped,
                          EslintViolation, FloatingPromise, IsPackageEntryPoint,
                          PackageMinCut, RegexLiteral (deeper), ResourceImbalance,
                          SanitizerCall (already fires), SecretVarRef,
                          SignatureNearDuplicate, SpectralMetric, SqlFkWithoutIndex,
                          SqlForeignKey, SqlMigrationOrderViolation, TlsConfigUnsafe,
                          TryCatchSwallow (already fires), WeakRandomCall
Domain-specific (rare)  : the rest
```

## Usage

```bash
cd packages/codegraph && npm run build
./examples/canary-project/validate.sh
```

Expected output ends with `Fact coverage : 51 / 83 (61%)` and `✓ tous les
ground-truth signals détectés`.

## Adding a new violation

1. Add a source file in `src/bad/` that triggers the new detector
2. Wire it from `src/index.ts` so it's not orphan (unless orphan-ness IS the test)
3. Add an `assert "label" "expression"` in `validate.sh`
4. Run `./validate.sh` — should pass
5. Update the table in this README
