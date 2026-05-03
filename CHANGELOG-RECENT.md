# Recent activity

> Auto-generated from `git log` by `scripts/regen-changelog.sh`.
> Reflects the last 50 commits, grouped by conventional
> commit type. The semantic version per package lives in each
> `package.json`.

Last update : 2026-05-03T23:36:30Z

## By type

### `perf` (4)

- **101b1b5** perf(toolkit): Salsa-iso boolean-params — 35ms → 0ms warm — 2026-05-04
- **20b9ace** perf(toolkit): Salsa-iso 5 taint chain detectors — 5×0ms warm — 2026-05-04
- **231be93** perf(toolkit): Salsa-iso resource-balance detector — 82ms → 0ms warm — 2026-05-04
- **c9e30bd** perf(toolkit): Salsa-iso magic-numbers detector — 539ms → 0ms warm (top hot detector eliminé) — 2026-05-04


### `refactor` (46)

- **a73b0b8** refactor(codegraph-mcp): split codegraphTruthPointFor (cyclo 22→4, cog 26→1) — truth-point.ts cleared — 2026-05-04
- **9e41eaa** refactor(codegraph): split loadConfig (cyclo 21→4, cog 38→3) — _shared.ts cleared — 2026-05-04
- **65c2c5c** refactor(codegraph): split mergeSqlSchemaResults (cyclo 21→1, cog 42→0) — drizzle-schema-detector.ts cleared — 2026-05-04
- **725ecdf** refactor(runtime-graph): split grangerRuntime (cyclo 22→5, cog 41→4) — granger-runtime.ts cleared — 2026-05-04
- **1bc0481** refactor(codegraph): split DbTableDetector.detect (cyclo 22→1, cog 47→0) — db-tables.ts cleared — 2026-05-04
- **05adaa7** refactor(codegraph): split extractDeprecatedUsageFileBundle (cyclo 23→2, cog 31→1) — deprecated-usage.ts cleared — 2026-05-04
- **1e46881** refactor(codegraph): split extractResourceBalanceFileBundle (cyclo 24→5, cog 27→5) — resource-balance.ts cleared — 2026-05-04
- **3b34ca1** refactor(codegraph): split importEslintViolations (cyclo 24→4, cog 29→2) — eslint-import.ts cleared — 2026-05-04
- **bd9fcb0** refactor(codegraph): split printDiffSummary (cyclo 24→4, cog 42→3) — diff.ts cleared — 2026-05-04
- **dc507d3** refactor(codegraph): split findArticulationPoints (cyclo 23→2, cog 46→0) — articulation-points.ts cleared — 2026-05-04
- **df37db7** refactor(codegraph): split diffTypedCalls (cyclo 25→5, cog 30→0) — diff/typed-calls.ts cleared — 2026-05-04
- **3814233** refactor(codegraph): split findSqlNamingViolations (cyclo 26→3, cog 42→3) — sql-naming.ts bomb-free — 2026-05-04
- **024b628** refactor(codegraph): split computeModuleMetrics (cyclo 27→4, cog 22→0) — module-metrics.ts bomb-free — 2026-05-04
- **8a6e1e1** refactor(codegraph): split applyTransitiveReexportCoverage (cyclo 11→4, cog 26→4) — test-coverage.ts FULLY bomb-free — 2026-05-04
- **2f99c5d** refactor(codegraph): split analyzeTestCoverage (cyclo 27→1, cog 54→0) — analyzeTestCoverage bomb-free — 2026-05-04
- **446c4b6** refactor(codegraph-mcp): split codegraphUncovered (cyclo 28→9, cog 29→3) — uncovered.ts bomb-free — 2026-05-04
- **357636e** refactor(codegraph): split scanImportsInSourceFile (cyclo 28→1, cog 45→0) — ts-imports.ts bomb-free — 2026-05-04
- **091d636** refactor(codegraph): split isAwaitedOrConsumed (cyclo 28→4, cog 47→5) — floating-promises.ts bomb-free — 2026-05-04
- **2afff33** refactor(codegraph): split tarjanScc (cyclo 13→3, cog 37→3) — dsm.ts FULLY bomb-free — 2026-05-04
- **5e798f4** refactor(codegraph): split computeDsm (cyclo 29→1, cog 45→0) — top-level orchestrator clean — 2026-05-04


## Full history

- **a73b0b8** refactor(codegraph-mcp): split codegraphTruthPointFor (cyclo 22→4, cog 26→1) — truth-point.ts cleared — 2026-05-04
- **9e41eaa** refactor(codegraph): split loadConfig (cyclo 21→4, cog 38→3) — _shared.ts cleared — 2026-05-04
- **65c2c5c** refactor(codegraph): split mergeSqlSchemaResults (cyclo 21→1, cog 42→0) — drizzle-schema-detector.ts cleared — 2026-05-04
- **725ecdf** refactor(runtime-graph): split grangerRuntime (cyclo 22→5, cog 41→4) — granger-runtime.ts cleared — 2026-05-04
- **1bc0481** refactor(codegraph): split DbTableDetector.detect (cyclo 22→1, cog 47→0) — db-tables.ts cleared — 2026-05-04
- **05adaa7** refactor(codegraph): split extractDeprecatedUsageFileBundle (cyclo 23→2, cog 31→1) — deprecated-usage.ts cleared — 2026-05-04
- **1e46881** refactor(codegraph): split extractResourceBalanceFileBundle (cyclo 24→5, cog 27→5) — resource-balance.ts cleared — 2026-05-04
- **3b34ca1** refactor(codegraph): split importEslintViolations (cyclo 24→4, cog 29→2) — eslint-import.ts cleared — 2026-05-04
- **bd9fcb0** refactor(codegraph): split printDiffSummary (cyclo 24→4, cog 42→3) — diff.ts cleared — 2026-05-04
- **dc507d3** refactor(codegraph): split findArticulationPoints (cyclo 23→2, cog 46→0) — articulation-points.ts cleared — 2026-05-04
- **df37db7** refactor(codegraph): split diffTypedCalls (cyclo 25→5, cog 30→0) — diff/typed-calls.ts cleared — 2026-05-04
- **3814233** refactor(codegraph): split findSqlNamingViolations (cyclo 26→3, cog 42→3) — sql-naming.ts bomb-free — 2026-05-04
- **024b628** refactor(codegraph): split computeModuleMetrics (cyclo 27→4, cog 22→0) — module-metrics.ts bomb-free — 2026-05-04
- **8a6e1e1** refactor(codegraph): split applyTransitiveReexportCoverage (cyclo 11→4, cog 26→4) — test-coverage.ts FULLY bomb-free — 2026-05-04
- **2f99c5d** refactor(codegraph): split analyzeTestCoverage (cyclo 27→1, cog 54→0) — analyzeTestCoverage bomb-free — 2026-05-04
- **446c4b6** refactor(codegraph-mcp): split codegraphUncovered (cyclo 28→9, cog 29→3) — uncovered.ts bomb-free — 2026-05-04
- **357636e** refactor(codegraph): split scanImportsInSourceFile (cyclo 28→1, cog 45→0) — ts-imports.ts bomb-free — 2026-05-04
- **091d636** refactor(codegraph): split isAwaitedOrConsumed (cyclo 28→4, cog 47→5) — floating-promises.ts bomb-free — 2026-05-04
- **2afff33** refactor(codegraph): split tarjanScc (cyclo 13→3, cog 37→3) — dsm.ts FULLY bomb-free — 2026-05-04
- **5e798f4** refactor(codegraph): split computeDsm (cyclo 29→1, cog 45→0) — top-level orchestrator clean — 2026-05-04
- **aa09cb1** refactor(codegraph): split runCrossDisciplineDetectors (cyclo 30→9, cog 43→6) — cross-discipline-orchestrator.ts bomb-free — 2026-05-04
- **798d038** refactor(codegraph): split scanEmitSitesInSourceFile (cyclo 31→3, cog 39→2) — event-emit-sites.ts bomb-free — 2026-05-04
- **bd1923f** refactor(codegraph-mcp): split codegraphDatalogQuery (cyclo 31→7, cog 52→3) — datalog-query.ts bomb-free — 2026-05-04
- **89be66f** refactor(codegraph): split extractArgumentsFileBundle (cyclo 33→3, cog 53→2) — arguments.ts bomb-free — 2026-05-04
- **c922d70** refactor(runtime-graph): split tdaPersistence (cyclo 33→5, cog 63→4) — tda-persistence.ts bomb-free — 2026-05-04
- **a4bd164** refactor(adr-toolkit): split bootstrapAdrs (cyclo 34→10, cog 50→4) — bootstrap.ts bomb-free — 2026-05-04
- **1d0518d** refactor(codegraph): split extractTensions (cyclo 34→10, cog 52→7) — tensions.ts bomb-free — 2026-05-04
- **8ae0127** refactor(codegraph): split computeCommunityDetection (cyclo 36→7, cog 43→6) — community-detection.ts bomb-free — 2026-05-04
- **e02af8d** refactor(codegraph): split computeComponentMetrics (cyclo 36→4, cog 44→0) — component-metrics.ts bomb-free — 2026-05-04
- **13162d1** refactor(codegraph): split extractTaintedVarsFileBundle (cyclo 37→6, cog 62→7) — tainted-vars.ts bomb-free — 2026-05-04
- **4e81398** refactor(codegraph): split analyzeCoChangeSync (cyclo 40→7, cog 54→1) — co-change.ts bomb-free — 2026-05-04
- **384b28a** refactor(codegraph): split extractSecurityPatternsFileBundle (cyclo 41→2, cog 119→1) — security-patterns.ts bomb-free — 2026-05-04
- **5cd34f2** refactor(codegraph): split computeGrangerCausality (cyclo 42→8, cog 53→2) — granger-causality.ts bomb-free — 2026-05-04
- **3340d64** refactor(datalog): split stratify (cyclo 42→2, cog 67→0) — stratify.ts bomb-free — 2026-05-04
- **ead1516** refactor(toolkit): split extractDriftPatternsFileBundle (cyclo 45→3) — drift-patterns.ts ALL bombs cleared — 2026-05-04
- **101b1b5** perf(toolkit): Salsa-iso boolean-params — 35ms → 0ms warm — 2026-05-04
- **20b9ace** perf(toolkit): Salsa-iso 5 taint chain detectors — 5×0ms warm — 2026-05-04
- **231be93** perf(toolkit): Salsa-iso resource-balance detector — 82ms → 0ms warm — 2026-05-04
- **c9e30bd** perf(toolkit): Salsa-iso magic-numbers detector — 539ms → 0ms warm (top hot detector eliminé) — 2026-05-04
- **702a89f** refactor(toolkit): split codegraphContext (cyclo 50→<15) — context.ts ALL bombs cleared — 2026-05-03
- **7369852** refactor(toolkit): split extractDeadCodeFileBundle (cyclo 50→3, cog 78→0) — dead-code.ts ALL bombs cleared — 2026-05-03
- **8caddca** refactor(toolkit): split computeAffectedFromCli + scanTestsImportingAffected — cli/index.ts ALL bombs cleared — 2026-05-03
- **e27c2be** refactor(toolkit): split codegraphAffected + dedup computeAffected — affected.ts ALL bombs cleared — 2026-05-03
- **66cbcd7** refactor(toolkit): split findContainingSymbol + buildLineToSymbol — _shared/ast-helpers.ts ALL bombs cleared — 2026-05-03
- **1ca9363** refactor(toolkit): split getTaintFromExpression + buildLineToSymbol — taint.ts ALL bombs cleared — 2026-05-03
- **22ced53** refactor(toolkit): split walkForManifests + buildPackageDepsIssues — package-deps.ts ALL bombs cleared — 2026-05-03
- **3b1d650** refactor(toolkit): split scanObjectWrites + detectListenerTriggers — state-machines.ts ALL bombs cleared — 2026-05-03
- **d534d97** refactor(toolkit): split constant-expressions (cyclo 35+23→under) — constant-expressions.ts ALL bombs cleared — 2026-05-03
- **f4ee98f** refactor(toolkit): split typed-calls (cyclo 18+16→under) — typed-calls.ts ALL bombs cleared — 2026-05-03
- **ac2b550** refactor(toolkit): split symbol-refs (cyclo 20+18→under) — symbol-refs.ts ALL bombs cleared — 2026-05-03
