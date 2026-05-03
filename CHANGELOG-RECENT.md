# Recent activity

> Auto-generated from `git log` by `scripts/regen-changelog.sh`.
> Reflects the last 50 commits, grouped by conventional
> commit type. The semantic version per package lives in each
> `package.json`.

Last update : 2026-05-03T22:35:12Z

## By type

### `perf` (4)

- **101b1b5** perf(toolkit): Salsa-iso boolean-params — 35ms → 0ms warm — 2026-05-04
- **20b9ace** perf(toolkit): Salsa-iso 5 taint chain detectors — 5×0ms warm — 2026-05-04
- **231be93** perf(toolkit): Salsa-iso resource-balance detector — 82ms → 0ms warm — 2026-05-04
- **c9e30bd** perf(toolkit): Salsa-iso magic-numbers detector — 539ms → 0ms warm (top hot detector eliminé) — 2026-05-04


### `refactor` (46)

- **4e81398** refactor(codegraph): split analyzeCoChangeSync (cyclo 40→7, cog 54→1) — co-change.ts bomb-free — 2026-05-04
- **384b28a** refactor(codegraph): split extractSecurityPatternsFileBundle (cyclo 41→2, cog 119→1) — security-patterns.ts bomb-free — 2026-05-04
- **5cd34f2** refactor(codegraph): split computeGrangerCausality (cyclo 42→8, cog 53→2) — granger-causality.ts bomb-free — 2026-05-04
- **3340d64** refactor(datalog): split stratify (cyclo 42→2, cog 67→0) — stratify.ts bomb-free — 2026-05-04
- **ead1516** refactor(toolkit): split extractDriftPatternsFileBundle (cyclo 45→3) — drift-patterns.ts ALL bombs cleared — 2026-05-04
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
- **c677082** refactor(toolkit): split compression-similarity (cyclo 18+16→under) — compression-similarity.ts ALL bombs cleared — 2026-05-03
- **ba540e4** refactor(toolkit): split analyzeCycles + tarjanScc — cycles.ts ALL bombs cleared — 2026-05-03
- **321cd83** refactor(toolkit): split classifyExportsFromBundles (cyclo 25→3) — unused-exports.ts ALL bombs cleared — 2026-05-03
- **dd61398** refactor(toolkit): split extractUnusedExportsFileBundle (cyclo 36→3) — 6 helpers per-pass — 2026-05-03


## Full history

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
- **c677082** refactor(toolkit): split compression-similarity (cyclo 18+16→under) — compression-similarity.ts ALL bombs cleared — 2026-05-03
- **ba540e4** refactor(toolkit): split analyzeCycles + tarjanScc — cycles.ts ALL bombs cleared — 2026-05-03
- **321cd83** refactor(toolkit): split classifyExportsFromBundles (cyclo 25→3) — unused-exports.ts ALL bombs cleared — 2026-05-03
- **dd61398** refactor(toolkit): split extractUnusedExportsFileBundle (cyclo 36→3) — 6 helpers per-pass — 2026-05-03
- **86cff0b** refactor(toolkit): split analyzeSqlSchema (cyclo 38→3) + dedupe SQL comparators to _shared/sql-helpers — 2026-05-03
- **8988d09** refactor(toolkit): split parseColumnProperty (cyclo 18→3) — drizzle-schema.ts ALL bombs cleared — 2026-05-03
- **377916d** refactor(toolkit): split parseIndexFunction (cyclo 23→3) — 2 helpers (body-unwrap + chain-parse) — 2026-05-03
- **23de1a8** refactor(toolkit): split parseDrizzleFile (cyclo 26→3) — 4 helpers + iteratePgTables generator — 2026-05-03
- **bdec532** refactor(toolkit): split collectOrmSignals (cyclo 28→3) — truth-points.ts ALL bombs cleared — 2026-05-03
- **1bdb707** refactor(toolkit): split collectAstSignals (cyclo 29→3) — 3 per-domain collectors — 2026-05-03
- **cde9741** refactor(toolkit): split collectSqlSignals (cyclo 33→3) — 5 helpers SQL pattern matching — 2026-05-03
- **423bc96** refactor(toolkit): split evaluate (cyclo 40→7, cog 123→4) — eval.ts ALL bombs cleared — 2026-05-03
- **c55801c** refactor(toolkit): split evaluateRule (cyclo 16→4) — 3 helpers (guards + head + proof) — 2026-05-03
- **953ea56** refactor(toolkit): split Lexer.skipWS (cyclo 16→3) — parser.ts ALL bombs cleared — 2026-05-03
- **a023167** refactor(toolkit): split Lexer.next (cyclo 19→under) — table single-char + tryTwoCharOp helper — 2026-05-03
- **4b0c89d** refactor(toolkit): split Parser.validateRule (cyclo 20→3) — 4 helpers safety checks — 2026-05-03
- **1878143** refactor(toolkit): split analyzeDrizzleSchema (cyclo 20→3) — 4 helpers (3 cmp + 1 parse loop) — 2026-05-03
- **4215f48** refactor(toolkit): split scanInlineSinks (cyclo 17→2, cog 63→3) — reuse trySink* helpers — 2026-05-03
- **ce0b0a8** refactor(toolkit): split detectListenerEntries (cyclo 23→under) — 4 helpers — 2026-05-03
- **47e3476** refactor(toolkit): split scanHttpOutboundSinks (cyclo 21→under) — 2 helpers — 2026-05-03
- **9efbf60** refactor(toolkit): split scanSinks (cyclo 18→under) — 4 per-kind sink helpers — 2026-05-03
- **2e2a8e8** refactor(toolkit): split prebuildSharedProjectIncremental (cyclo 16→3) — 3 helpers + reuse findTsConfigPath — 2026-05-03
- **673129e** refactor(toolkit): split resolveTsConfigAndSharedProject (cyclo 16→4) — 3 helpers — 2026-05-03
- **4b6165c** refactor(toolkit): split buildFlow (cyclo 19→4) — 4 helpers BFS-extracted — 2026-05-03
- **a5ac751** refactor(toolkit): split buildTestFilesIndex (cyclo 17→1) — 5 helpers + ImportIndices struct — 2026-05-03
- **62de53a** refactor(toolkit): split analyzeScope (cyclo 17→3) — extract per-kind handlers — 2026-05-03
- **6cfd2fe** refactor(toolkit): split analyzePackageDeps (cyclo 17→4) — 3 helpers — 2026-05-03
- **69a032e** refactor(toolkit): split runPostSnapshotMetrics (cyclo 20→4) — generic metric step + 3 metric runners — 2026-05-03
- **3e30c42** refactor(toolkit): split buildTruthPointsFromSignals (cyclo 34→3) — 4 helpers per-table — 2026-05-03
- **6190869** refactor(toolkit): split state-machines top-level — analyze + buildFromBundles — 2026-05-03
