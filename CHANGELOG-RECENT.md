# Recent activity

> Auto-generated from `git log` by `scripts/regen-changelog.sh`.
> Reflects the last 50 commits, grouped by conventional
> commit type. The semantic version per package lives in each
> `package.json`.

Last update : 2026-05-03T20:08:25Z

## By type

### `feat` (1)

- **af41582** feat(toolkit): symbolic simplification facts + 5 composite rules cross-discipline — 2026-05-03


### `fix` (8)

- **50eb1f8** fix(toolkit): articulation-point rule — exclure package entry points (FP systemique) — 2026-05-03
- **8844d31** fix(toolkit): FSM-ORPHAN 3→0 — fixture skip + Attribute API + satisfies unwrap — 2026-05-03
- **1b532d0** fix(toolkit): grandfather 3 cross-package loadConfig pairs (FP shape-match) — 2026-05-03
- **686fb09** fix(toolkit): quick-win violations — 4 fixes (1 floating-promise FP, 1 return-then-else, 2 deprecated FPs) — 2026-05-03
- **e19790b** fix(toolkit): cochange-without-cotest filter to TS source — 5 FPs eliminated — 2026-05-03
- **25fc296** fix(toolkit): kill META-CRITICAL (7→0) + 2 bugs détecteur + 6 tests — 2026-05-03
- **70afbdc** fix(toolkit): clean 93 violations (534→441, −17.4%) sans bypass — 2026-05-03
- **866eb25** fix(toolkit): bugs #1 #2 #3 #4 trouvés via test externe Hono — 2026-05-03


### `perf` (3)

- **dcf47d4** perf(toolkit): split stat-from-read en prebuild + layered allDeprecatedUsage — 2026-05-03
- **f55039d** perf(toolkit): Salsa-iso compression-similarity (per-file snippets cached) — 2026-05-03
- **7151cfd** perf(toolkit): Salsa-isolate 3 hot detectors (co-change, drift, const-expr) — 2026-05-03


### `refactor` (33)

- **4b6165c** refactor(toolkit): split buildFlow (cyclo 19→4) — 4 helpers BFS-extracted — 2026-05-03
- **a5ac751** refactor(toolkit): split buildTestFilesIndex (cyclo 17→1) — 5 helpers + ImportIndices struct — 2026-05-03
- **62de53a** refactor(toolkit): split analyzeScope (cyclo 17→3) — extract per-kind handlers — 2026-05-03
- **6cfd2fe** refactor(toolkit): split analyzePackageDeps (cyclo 17→4) — 3 helpers — 2026-05-03
- **69a032e** refactor(toolkit): split runPostSnapshotMetrics (cyclo 20→4) — generic metric step + 3 metric runners — 2026-05-03
- **3e30c42** refactor(toolkit): split buildTruthPointsFromSignals (cyclo 34→3) — 4 helpers per-table — 2026-05-03
- **6190869** refactor(toolkit): split state-machines top-level — analyze + buildFromBundles — 2026-05-03
- **bddfb2a** refactor(toolkit): split data-flows top-level (analyzeDataFlows + buildDataFlowsFromBundles) — 2026-05-03
- **d176584** refactor(toolkit): split renderLevel1/2/3 — synopsis/builder.ts ALL bombs cleared — 2026-05-03
- **8f1792b** refactor(toolkit): split buildComponents (cyclo 24→under) — 5 helpers (groupByComp, edgeDeg, topFiles, tags, adrs) — 2026-05-03
- **275466c** refactor(toolkit): split buildSynopsis (cyclo 75→5, cog 130→4) — 9 helpers + ctx struct — 2026-05-03
- **e4019fb** refactor(toolkit): builder.ts ALL bombs cleared — split TruthPoints + PackageDeps + TaintViolations — 2026-05-03
- **af4705f** refactor(toolkit): split renderCoreFlows (cyclo 22→4) — 3 helpers (group + table + detail) — 2026-05-03
- **69911dc** refactor(toolkit): split renderStats (cyclo 24→11) — 5 helpers stats lines — 2026-05-03
- **9609b7d** refactor(toolkit): split renderIndex (cyclo 28→3) — 3 helpers + bucket pattern factor — 2026-05-03
- **a0add06** refactor(toolkit): split renderModuleFiche (cyclo 32→4) — 5 helpers section-by-section — 2026-05-03
- **020e949** refactor(toolkit): split renderModules (cyclo 35→12) — 4 helpers index builders — 2026-05-03
- **df1ee8c** refactor(toolkit): split renderEventFlows (cyclo 25→5, cog 63→4) — 5 helpers extraits — 2026-05-03
- **64b3dcd** refactor(toolkit): split exportFacts batch 5 — eliminate ALL bombs in facts/index.ts (CrossDiscipline + Tier234) — 2026-05-03
- **fe16098** refactor(toolkit): split exportFacts batch 4 — eliminate 3 helper-bombs (Cycle, Security, Package) — 2026-05-03


### `chore` (1)

- **f2f93bc** chore(brief): regen CLAUDE-CONTEXT + CHANGELOG post-refactor (553→534) — 2026-05-03


### `docs` (4)

- **ee89730** docs(validation): self-analysis run #2 — toolkit voit 553 violations sur lui-même — 2026-05-03
- **9a5d5ac** docs(validation): run #1.5 — composite rules sur Sentinel — 33× signal-to-noise — 2026-05-03
- **a191d61** docs(validation): full-chain run #1 — 4 bugs trouvés sur Hono — 2026-05-03
- **095661e** docs(validation): run #1 — Hono framework (186 files, 3.5s, 0 crash, 0 hallucination) — 2026-05-03


## Full history

- **4b6165c** refactor(toolkit): split buildFlow (cyclo 19→4) — 4 helpers BFS-extracted — 2026-05-03
- **a5ac751** refactor(toolkit): split buildTestFilesIndex (cyclo 17→1) — 5 helpers + ImportIndices struct — 2026-05-03
- **62de53a** refactor(toolkit): split analyzeScope (cyclo 17→3) — extract per-kind handlers — 2026-05-03
- **6cfd2fe** refactor(toolkit): split analyzePackageDeps (cyclo 17→4) — 3 helpers — 2026-05-03
- **69a032e** refactor(toolkit): split runPostSnapshotMetrics (cyclo 20→4) — generic metric step + 3 metric runners — 2026-05-03
- **3e30c42** refactor(toolkit): split buildTruthPointsFromSignals (cyclo 34→3) — 4 helpers per-table — 2026-05-03
- **6190869** refactor(toolkit): split state-machines top-level — analyze + buildFromBundles — 2026-05-03
- **bddfb2a** refactor(toolkit): split data-flows top-level (analyzeDataFlows + buildDataFlowsFromBundles) — 2026-05-03
- **d176584** refactor(toolkit): split renderLevel1/2/3 — synopsis/builder.ts ALL bombs cleared — 2026-05-03
- **8f1792b** refactor(toolkit): split buildComponents (cyclo 24→under) — 5 helpers (groupByComp, edgeDeg, topFiles, tags, adrs) — 2026-05-03
- **275466c** refactor(toolkit): split buildSynopsis (cyclo 75→5, cog 130→4) — 9 helpers + ctx struct — 2026-05-03
- **e4019fb** refactor(toolkit): builder.ts ALL bombs cleared — split TruthPoints + PackageDeps + TaintViolations — 2026-05-03
- **af4705f** refactor(toolkit): split renderCoreFlows (cyclo 22→4) — 3 helpers (group + table + detail) — 2026-05-03
- **69911dc** refactor(toolkit): split renderStats (cyclo 24→11) — 5 helpers stats lines — 2026-05-03
- **9609b7d** refactor(toolkit): split renderIndex (cyclo 28→3) — 3 helpers + bucket pattern factor — 2026-05-03
- **a0add06** refactor(toolkit): split renderModuleFiche (cyclo 32→4) — 5 helpers section-by-section — 2026-05-03
- **020e949** refactor(toolkit): split renderModules (cyclo 35→12) — 4 helpers index builders — 2026-05-03
- **df1ee8c** refactor(toolkit): split renderEventFlows (cyclo 25→5, cog 63→4) — 5 helpers extraits — 2026-05-03
- **50eb1f8** fix(toolkit): articulation-point rule — exclure package entry points (FP systemique) — 2026-05-03
- **8844d31** fix(toolkit): FSM-ORPHAN 3→0 — fixture skip + Attribute API + satisfies unwrap — 2026-05-03
- **1b532d0** fix(toolkit): grandfather 3 cross-package loadConfig pairs (FP shape-match) — 2026-05-03
- **686fb09** fix(toolkit): quick-win violations — 4 fixes (1 floating-promise FP, 1 return-then-else, 2 deprecated FPs) — 2026-05-03
- **e19790b** fix(toolkit): cochange-without-cotest filter to TS source — 5 FPs eliminated — 2026-05-03
- **64b3dcd** refactor(toolkit): split exportFacts batch 5 — eliminate ALL bombs in facts/index.ts (CrossDiscipline + Tier234) — 2026-05-03
- **fe16098** refactor(toolkit): split exportFacts batch 4 — eliminate 3 helper-bombs (Cycle, Security, Package) — 2026-05-03
- **cbc6a6b** refactor(toolkit): split exportFacts batch 3 — exportFacts cyclo 84→4 (sous le seuil) — 2026-05-03
- **5888c3e** refactor(toolkit): split exportFacts batch 2 — extract graph metrics + listeners (cyclomatic 102→84) — 2026-05-03
- **f8e2fdd** refactor(toolkit): split exportFacts en 5 emit helpers (cyclomatic 142→102) — 2026-05-03
- **7c6668c** refactor(toolkit): kill LONG-FN-BY-PARAMS (5→0) + fix CHAOS-AMPLIFIER FP (6→3) — 2026-05-03
- **96048d7** refactor(toolkit): extract NCD duplicates → ast-helpers + drivers/_common (NCD: 16→12) — 2026-05-03
- **dcf47d4** perf(toolkit): split stat-from-read en prebuild + layered allDeprecatedUsage — 2026-05-03
- **f55039d** perf(toolkit): Salsa-iso compression-similarity (per-file snippets cached) — 2026-05-03
- **c24fb16** refactor(toolkit): tame AWAIT-IN-LOOP batch 6 — 33→0, AWAIT-IN-LOOP éliminé — 2026-05-03
- **2b4ebc0** refactor(toolkit): tame AWAIT-IN-LOOP batch 3+4+5 — detectors + extractors (58→33) — 2026-05-03
- **9a86461** refactor(toolkit): tame AWAIT-IN-LOOP batch 2 — _shared, regenerate-anchors, drivers (70→58) — 2026-05-03
- **5933423** refactor(toolkit): tame AWAIT-IN-LOOP — parallelize hot paths + mark scaffold (105→70) — 2026-05-03
- **fbebea4** refactor(toolkit): extract makeIsExempt helper (NCD: 25→16, total 434→422) — 2026-05-03
- **25fc296** fix(toolkit): kill META-CRITICAL (7→0) + 2 bugs détecteur + 6 tests — 2026-05-03
- **70afbdc** fix(toolkit): clean 93 violations (534→441, −17.4%) sans bypass — 2026-05-03
- **b0f2c9a** refactor(toolkit): split cli/index.ts god-file (2190→1520 LOC, −30%) — 2026-05-03
- **c613ac7** refactor(toolkit): split analyzer.ts:runDeterministicDetectors en 5 phases — 2026-05-03
- **7151cfd** perf(toolkit): Salsa-isolate 3 hot detectors (co-change, drift, const-expr) — 2026-05-03
- **f2f93bc** chore(brief): regen CLAUDE-CONTEXT + CHANGELOG post-refactor (553→534) — 2026-05-03
- **5f8d691** refactor(toolkit): split god-files + fix REDOS detector + tests hubs — 2026-05-03
- **ee89730** docs(validation): self-analysis run #2 — toolkit voit 553 violations sur lui-même — 2026-05-03
- **9a5d5ac** docs(validation): run #1.5 — composite rules sur Sentinel — 33× signal-to-noise — 2026-05-03
- **af41582** feat(toolkit): symbolic simplification facts + 5 composite rules cross-discipline — 2026-05-03
- **866eb25** fix(toolkit): bugs #1 #2 #3 #4 trouvés via test externe Hono — 2026-05-03
- **a191d61** docs(validation): full-chain run #1 — 4 bugs trouvés sur Hono — 2026-05-03
- **095661e** docs(validation): run #1 — Hono framework (186 files, 3.5s, 0 crash, 0 hallucination) — 2026-05-03
