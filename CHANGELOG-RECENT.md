# Recent activity

> Auto-generated from `git log` by `scripts/regen-changelog.sh`.
> Reflects the last 50 commits, grouped by conventional
> commit type. The semantic version per package lives in each
> `package.json`.

Last update : 2026-05-05T12:20:36Z

## By type

### `feat` (43)

- **1488e38** feat(codegraph): ADR-026 phase D — pipeline composite statique × dynamique × salsa — 2026-05-05
- **dd611b7** feat(codegraph): ADR-026 phase C.2 — cache module-level de l'éval Datalog — 2026-05-05
- **18a45a8** feat(codegraph): ADR-026 phase A.4 — close 3 outliers (full snapshot parity) — 2026-05-05
- **558aa7d** feat(codegraph): ADR-026 phase C — Salsa caching for Datalog runner — 2026-05-05
- **11deb4b** feat(codegraph): ADR-026 phases A.1+A.3 — shadow mode + useDatalog swap — 2026-05-05
- **f8b1256** feat(codegraph): Phase γ.15 — port code-quality-patterns au pattern Datalog — 2026-05-05
- **6951dc6** feat(codegraph): Phase γ.14 — port drift-patterns au pattern Datalog — 2026-05-05
- **7cb5ef4** feat(codegraph): Phase γ.13 — port security-patterns au pattern Datalog — 2026-05-05
- **4baa9d0** feat(codegraph): Phase γ.12 — port resource-balance au pattern Datalog — 2026-05-05
- **cc6598b** feat(codegraph): Phase γ.11 — port tainted-vars au pattern Datalog — 2026-05-05
- **91912a1** feat(codegraph): Phase γ.10 — port event-emit-sites au pattern Datalog — 2026-05-05
- **2cfe578** feat(codegraph): Phase γ.9 — port arguments au pattern Datalog — 2026-05-05
- **dad7dc1** feat(codegraph): Phase γ.8 — port constant-expressions au pattern Datalog — 2026-05-05
- **393fc2c** feat(codegraph): Phase γ.7 — port barrels + env-usage au pattern Datalog — 2026-05-05
- **14fe493** feat(codegraph): Phase γ.6 — port event-listener-sites au pattern Datalog — 2026-05-05
- **a2bc182** feat(codegraph): Phase γ.4c — 5 derniers détecteurs ts-morph portés Datalog — 2026-05-04
- **b2a709e** feat(codegraph): Phase γ.4b — consolide + 3 nouveaux détecteurs Datalog — 2026-05-04
- **3175c64** feat(codegraph): Phase γ.4 — prototype Datalog detectors (magic-numbers + dead-code) — 2026-05-04
- **06c21b1** feat(codegraph): Phase γ.3b — wire batch warmup dans analyzer.ts — 2026-05-04
- **4b218d2** feat(codegraph): Phase γ.3b — batch dispatch infrastructure (non-wired) — 2026-05-04


### `perf` (2)

- **fc9449a** perf(co-change): --no-merges --no-renames sur git log — 2026-05-04
- **c626690** perf(codegraph): parallelize delta reads in applyDeltasInOrder — 2026-05-04


### `refactor` (1)

- **be79c7b** refactor(codegraph): Phase γ.5 — cleanup workers cold code (Phase β/γ.2/γ.3) — 2026-05-05


### `chore` (2)

- **e2fde62** chore(codegraph): bump @liby-tools/codegraph to v0.4.0 — 2026-05-05
- **5cc82a0** chore(hooks): dedup PreToolUse + PostToolUse via SHA40 cache TTL 5min — 2026-05-05


### `docs` (2)

- **3bcc427** docs(adr-026): close-out — 18/21 ts-morph ports done, 3 non-portables — 2026-05-05
- **84b2f76** docs(adr-024): anchor markers sur les 3 helpers BSP — 2026-05-04


## Full history

- **1488e38** feat(codegraph): ADR-026 phase D — pipeline composite statique × dynamique × salsa — 2026-05-05
- **dd611b7** feat(codegraph): ADR-026 phase C.2 — cache module-level de l'éval Datalog — 2026-05-05
- **18a45a8** feat(codegraph): ADR-026 phase A.4 — close 3 outliers (full snapshot parity) — 2026-05-05
- **e2fde62** chore(codegraph): bump @liby-tools/codegraph to v0.4.0 — 2026-05-05
- **558aa7d** feat(codegraph): ADR-026 phase C — Salsa caching for Datalog runner — 2026-05-05
- **5cc82a0** chore(hooks): dedup PreToolUse + PostToolUse via SHA40 cache TTL 5min — 2026-05-05
- **11deb4b** feat(codegraph): ADR-026 phases A.1+A.3 — shadow mode + useDatalog swap — 2026-05-05
- **3bcc427** docs(adr-026): close-out — 18/21 ts-morph ports done, 3 non-portables — 2026-05-05
- **f8b1256** feat(codegraph): Phase γ.15 — port code-quality-patterns au pattern Datalog — 2026-05-05
- **6951dc6** feat(codegraph): Phase γ.14 — port drift-patterns au pattern Datalog — 2026-05-05
- **7cb5ef4** feat(codegraph): Phase γ.13 — port security-patterns au pattern Datalog — 2026-05-05
- **4baa9d0** feat(codegraph): Phase γ.12 — port resource-balance au pattern Datalog — 2026-05-05
- **cc6598b** feat(codegraph): Phase γ.11 — port tainted-vars au pattern Datalog — 2026-05-05
- **91912a1** feat(codegraph): Phase γ.10 — port event-emit-sites au pattern Datalog — 2026-05-05
- **2cfe578** feat(codegraph): Phase γ.9 — port arguments au pattern Datalog — 2026-05-05
- **dad7dc1** feat(codegraph): Phase γ.8 — port constant-expressions au pattern Datalog — 2026-05-05
- **393fc2c** feat(codegraph): Phase γ.7 — port barrels + env-usage au pattern Datalog — 2026-05-05
- **14fe493** feat(codegraph): Phase γ.6 — port event-listener-sites au pattern Datalog — 2026-05-05
- **be79c7b** refactor(codegraph): Phase γ.5 — cleanup workers cold code (Phase β/γ.2/γ.3) — 2026-05-05
- **a2bc182** feat(codegraph): Phase γ.4c — 5 derniers détecteurs ts-morph portés Datalog — 2026-05-04
- **b2a709e** feat(codegraph): Phase γ.4b — consolide + 3 nouveaux détecteurs Datalog — 2026-05-04
- **3175c64** feat(codegraph): Phase γ.4 — prototype Datalog detectors (magic-numbers + dead-code) — 2026-05-04
- **06c21b1** feat(codegraph): Phase γ.3b — wire batch warmup dans analyzer.ts — 2026-05-04
- **4b218d2** feat(codegraph): Phase γ.3b — batch dispatch infrastructure (non-wired) — 2026-05-04
- **444bc98** feat(codegraph): Phase γ.3a — affinity routing + LRU cache intra-worker — 2026-05-04
- **c2ab5c7** feat(codegraph): Phase γ.2c — wire les 6 ts-morph détecteurs restants aux workers — 2026-05-04
- **5a40459** feat(codegraph): Phase γ.2b — wire long-functions + dead-code aux workers — 2026-05-04
- **d94cab1** feat(codegraph): Phase γ.2 — workers ts-morph via mini-Project local — 2026-05-04
- **9a741e3** feat(codegraph): Phase 2.8 — dead-code + event-emit-sites portés (14/65) — 2026-05-04
- **07b0dcf** feat(codegraph): Phase 2.7 — function-complexity + long-functions portés (12/65) — 2026-05-04
- **7366782** feat(codegraph): Phase γ.1 — cost-model auto-tuning LIBY_BSP_WORKERS=auto — 2026-05-04
- **896219e** feat(codegraph): Phase 2.6 — oauth-scope-literals porté (10/65) — 2026-05-04
- **76362ea** feat(codegraph): Phase 2.5 — ts-imports porté au pattern BSP monoïdal — 2026-05-04
- **59d89c8** feat(codegraph): Phase β.3 — ADR-025 + template BSP pour futurs détecteurs — 2026-05-04
- **7dc918b** feat(codegraph): Phase β.2 — worker mode opt-in pour analyzeTodos — 2026-05-04
- **de8b02a** feat(codegraph): Phase β — worker_threads dispatch via WorkerPool — 2026-05-04
- **3399c54** feat(codegraph): Phase 2.4 — sanitizers + taint-sinks portés (8/65) — 2026-05-04
- **f066d43** feat(codegraph): Phase 2.3 — 3 détecteurs portés (boolean-params, eval-calls, crypto-algo) — 2026-05-04
- **84b2f76** docs(adr-024): anchor markers sur les 3 helpers BSP — 2026-05-04
- **190b979** feat(codegraph): Phase 2.2 — hardcoded-secrets porté + ADR-024 — 2026-05-04
- **abd6ad7** feat(codegraph): Phase 2.1 — 2 détecteurs portés au pattern BSP monoïdal — 2026-05-04
- **415d382** feat(codegraph): Phase 1 BSP — monoid algebra + scheduler déterministe — 2026-05-04
- **576e358** feat(toolkit): press-button complet — RECIPES + --with-runtime + 5 awaits paralléllisés — 2026-05-04
- **c17c0c1** feat(runtime-graph): press-button CLI `probe` + refactor 2 bombs — 2026-05-04
- **e1b0a02** feat(runtime-graph): 5 nouvelles disciplines pluridisciplinaires — 2026-05-04
- **410daa0** feat(runtime-graph): static↔runtime divergence — KL + Pareto + coverage drift — 2026-05-04
- **fc9449a** perf(co-change): --no-merges --no-renames sur git log — 2026-05-04
- **c626690** perf(codegraph): parallelize delta reads in applyDeltasInOrder — 2026-05-04
- **b4959d9** feat(runtime-graph): math optim suggester — universel pour toute app — 2026-05-04
- **7d4d382** feat(runtime-graph): fn-wrap iitm — capture exacte des call edges cross-module — 2026-05-04
