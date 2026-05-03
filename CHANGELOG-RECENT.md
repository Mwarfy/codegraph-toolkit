# Recent activity

> Auto-generated from `git log` by `scripts/regen-changelog.sh`.
> Reflects the last 50 commits, grouped by conventional
> commit type. The semantic version per package lives in each
> `package.json`.

Last update : 2026-05-03T21:07:35Z

## By type

### `fix` (5)

- **50eb1f8** fix(toolkit): articulation-point rule — exclure package entry points (FP systemique) — 2026-05-03
- **8844d31** fix(toolkit): FSM-ORPHAN 3→0 — fixture skip + Attribute API + satisfies unwrap — 2026-05-03
- **1b532d0** fix(toolkit): grandfather 3 cross-package loadConfig pairs (FP shape-match) — 2026-05-03
- **686fb09** fix(toolkit): quick-win violations — 4 fixes (1 floating-promise FP, 1 return-then-else, 2 deprecated FPs) — 2026-05-03
- **e19790b** fix(toolkit): cochange-without-cotest filter to TS source — 5 FPs eliminated — 2026-05-03


### `refactor` (45)

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


## Full history

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
