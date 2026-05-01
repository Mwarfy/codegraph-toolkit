# Phase 5 — Composite backlog (post-Tier 14)

> Audit exhaustif des invariants déterministes débloqués par Tier 14
> (cross-fn taint 1-hop + aggregates Datalog + proof tree).
> Source : 8 fils d'exploration parallèles (archéologie TODO, gap facts,
> portage CodeQL/Semgrep, cross-langue, aggregates, taint cross-fn,
> extractors, tensions actives). 80 candidats bruts → 50 dédupliqués/rangés.
>
> Range strictement par valeur × (1/coût). Top entries = preuves Sentinel
> avec file:line réel. Citations toujours présentes.
> Pour chaque candidat ratchet (`AdrXxxGrandfathered`) compatible ADR-022.

---

## Tier 15 — high value × low cost (facts existants, ≤30min chacun)

> Ces 26 rules s'écrivent en pur Datalog avec les facts actuels (43 émis).
> Aucun nouvel extractor requis. Cible : **un PR par rule** ou un `tier-15.dl`
> bundle si on veut amortir le ratchet.

### 1. composite-cross-fn-sql-injection
- **Pattern** : route handler passe `req.body.params.sql` à un helper qui call `db.query(sql)`. Webhook → service → `getPool().query()` typique.
- **Facts** : `TaintedArgumentToCall` + `FunctionParam` + `TaintSink(kind="sql")` (tous existants Tier 14).
- **Inspiration** : CodeQL `js/sql-injection` étendu cross-fn ; CWE-089.
- **Coût** : trivial (5 lignes Datalog miroir CWE-089 avec `TaintedParam`).
- **Valeur Sentinel** : 3+ TPs réels confirmés. Vu : [api/webhooks/index.ts:176](sentinel-core/src/api/webhooks/index.ts:176) → [admin.ts:151](sentinel-core/src/api/webhooks/admin.ts:151) (`db.query(sql)` où `sql=params?.sql`, sanitizer `startsWith('SELECT')` non reconnu) ; [system.ts:277](sentinel-core/src/api/routes/system.ts:277) → [decision-journal.ts:115](sentinel-core/src/kernel/decision-journal.ts:115) (`type` tainté dans `WHERE conditions.join(...)`).

### 2. composite-tainted-flow-stricter-with-var-level
- **Pattern** : remplace l'approximation file-reach de `composite-tainted-flow.dl:24-25` par un join var-level via `TaintedParam` chain.
- **Facts** : existants (réécriture de la rule actuelle).
- **Inspiration** : CodeQL path-queries (sans porter le moteur).
- **Coût** : small (réécriture ~15 lignes).
- **Valeur Sentinel** : précision massive — division par ~10 du bruit du composite-tainted-flow actuel. Effet ratchet immédiat sur l'ADR.

### 3. composite-cross-fn-cmd-injection
- **Pattern** : route → helper qui exec/execSync/execFile avec param tainté.
- **Facts** : `TaintedArgumentToCall` + `FunctionParam` + `TaintSink(kind="exec")`.
- **Inspiration** : CWE-078 cross-fn ; CodeQL `js/command-line-injection`.
- **Coût** : small (rule miroir CWE-078 + join `TaintedParam`).
- **Valeur Sentinel** : 5 TPs probables. [api/routes/system.ts:341,365](sentinel-core/src/api/routes/system.ts:341) (`exec` direct sur `sha=m[1]` regex) ; [index.ts:79](sentinel-core/src/index.ts:79) (`execSync(\`lsof -ti:${port}\`)`) ; `mcp/tools/codegraph.ts` (`execFile`).

### 4. composite-tainted-vars-destructuring
- **Pattern** : `const { id, name } = req.body` skippé par `tainted-vars.ts:115-116` ("Skip les destructurings").
- **Facts** : extension `TaintedVarDecl` existante (~20 lignes dans `tainted-vars.ts`).
- **Inspiration** : extension naturelle Pass 1.
- **Coût** : small (<30min, BindingElement walk).
- **Valeur Sentinel** : 5-10 TPs — `const { ... } = req.body` est idiomatique Express/Fastify.

### 5. composite-truth-point-god-reader (aggregate `.count`)
- **Pattern** : un fichier qui lit > 5 truth-points = knowledge sink, refactor candidate.
- **Skeleton** :
  ```
  .count TpReadHub(F: symbol, n: number) by TruthPointReader(_, F)
  Adr025TpReaderGod(F) :- TpReadHub(F, n), n > 5, !Adr025Grandfathered(F).
  ```
- **Facts** : `TruthPointReader` + aggregate `.count` (Tier 14).
- **Inspiration** : god-class (Lanza/Marinescu).
- **Coût** : trivial.
- **Valeur Sentinel** : 6 TPs confirmés via codegraph (`system.ts`, `dimension-learner`, `youtube-publisher`, `video-chain-orchestrator`, `publish-reconciler`, `content-optimization-loop`).

### 6. composite-cross-fn-path-traversal
- **Pattern** : route → loader fn avec path tainté → `fs.readFile`/`fs.readdir`.
- **Facts** : existants (`TaintedParam` + `TaintSink(kind="fs-read")`).
- **Inspiration** : CWE-022 étendu cross-fn ; CodeQL `js/path-injection`.
- **Coût** : small.
- **Valeur Sentinel** : 4 TPs. [api/routes/codegraph.ts:76,93](sentinel-core/src/api/routes/codegraph.ts:76) (`loadSnapshotByIndex(index)` avec `index` ex-`url.searchParams.get`) ; [mcp/tools/codegraph.ts:1222,2685,2722](sentinel-core/src/mcp/tools/codegraph.ts:1222) (`fs.readFile(absPath)` param-driven).

### 7. composite-fat-table (aggregate `.count`)
- **Pattern** : table avec > 25 colonnes = denormalization smell.
- **Skeleton** :
  ```
  .count TableWidth(T: symbol, n: number) by SqlColumn(T, _, _, _, _)
  Adr029FatTable(T) :- TableWidth(T, n), n > 25.
  ```
- **Facts** : `SqlColumn` + `.count`.
- **Inspiration** : DBA lint, refacto/normalization patterns.
- **Coût** : trivial.
- **Valeur Sentinel** : 6 TPs (`orders=71`, `product_scores=38`, `daily_financials`, `peer_reviews`, `system_snapshot`, `prospect_profiles`).

### 8. composite-long-function-by-params (aggregate `.max`)
- **Pattern** : fonction avec ≥ 7 params = options-object refactor (boolean trap amplifié).
- **Skeleton** :
  ```
  .max MaxParam(F: symbol, S: symbol, m: number) by FunctionParam(F, S, _, V)
  Adr033ParamOverload(F, S) :- MaxParam(F, S, m), m >= 6.
  ```
- **Facts** : `FunctionParam` + `.max`.
- **Inspiration** : Clean Code Martin — "ideal nb of args is zero".
- **Coût** : trivial.
- **Valeur Sentinel** : 10+ hits confirmés.

### 9. composite-env-var-spread (aggregate `.count`)
- **Pattern** : env var lue > 2 fois sans wrapper resolver typé (ADR-019). Cible secrets surtout.
- **Skeleton** :
  ```
  .count EnvSpread(V: symbol, n: number) by EnvRead(_, _, V, _)
  Adr030EnvSpread(V) :- EnvSpread(V, n), n > 2, !Adr019Wrapped(V), !EnvWhitelist(V).
  ```
- **Facts** : `EnvRead` + `.count`.
- **Coût** : trivial.
- **Valeur Sentinel** : 7+ hits (`JWT_SECRET`, `GMAIL_CLIENT_SECRET` à 3 reads).

### 10. composite-hub-untested
- **Pattern** : fichier `ModuleFanIn ≥ 20` sans `TestedFile` = blast-radius critique non couvert.
- **Facts** : `ModuleFanIn` + anti-join `TestedFile`.
- **Inspiration** : Lanza/Marinescu hub metric.
- **Coût** : trivial.
- **Valeur Sentinel** : 4 TPs concrets (`logger.ts:107`, `types.ts:37`, `video-chain-orchestrator.ts:23`, `reporter.ts:17`).

### 11. composite-articulation-with-floating-promise
- **Pattern** : nœud d'articulation (single-point-of-failure) avec `FloatingPromise` non awaitée = erreur silencieuse dans hub critique. Casse ADR-021.
- **Facts** : `ArticulationPoint` + `FloatingPromise`.
- **Inspiration** : Erlang/OTP supervisor strategies + Go SA2002.
- **Coût** : trivial.
- **Valeur Sentinel** : 2-4 TPs probables (scheduler, video-chain-orchestrator, reporter).

### 12. composite-orphan-export
- **Pattern** : symbol exporté sans `SymbolCallEdge` cross-fichier ni `EntryPoint` = export mort.
- **Facts** : `SymbolSignature` + anti-join `SymbolCallEdge`.
- **Inspiration** : ts-prune / unused-exports déjà détecté en synopsis ("safe-to-remove").
- **Coût** : small (anti-join Datalog-natif).
- **Valeur Sentinel** : 5+ TPs.

### 13. composite-cross-pack-bypass
- **Pattern** : pack A importe directement un fichier interne de pack B (bypass event-bus, viole ADR-004).
- **Facts** : `Imports` + `FileTag` (les deux sous-utilisés).
- **Inspiration** : Bazel `layering_check`.
- **Coût** : trivial (pure Datalog).
- **Valeur Sentinel** : 5+ TPs probables (cross-block leaks).

### 14. composite-tag-mismatch
- **Pattern** : `FileTag(file, 'block')` sans `defaultSchedule` (ADR-011), `FileTag(file, 'migration')` sans timestamp prefix valide. `FileTag` aujourd'hui sous-utilisé.
- **Facts** : `FileTag` + `BlockCatalogDecl` etc.
- **Coût** : small.
- **Valeur Sentinel** : 5+ TPs (multiple ADRs hookable).

### 15. composite-cochange-without-cotest
- **Pattern** : `fileA` co-change ≥ 5 fois avec `fileB` (jaccard ≥ 60), `fileA` testé mais `fileB` non = test gap caché.
- **Facts** : `CoChange` + `TestedFile` (CoChange est aujourd'hui à 0 rule).
- **Inspiration** : Bazel coverage targets, Google Rosie.
- **Coût** : small.
- **Valeur Sentinel** : 3-6 TPs probables.

### 16. composite-cross-function-taint-multi-hop
- **Pattern** : transitive closure sur `TaintedParam` (limité à 1 hop dans Tier 14, cf. `composite-cross-function-taint.dl:25`). Chains route → service → kernel = courantes Sentinel.
- **Skeleton** :
  ```
  TaintedParam(F2,S2,P2,Src) :-
    TaintedParam(F,S,P,Src),
    TaintedArgumentToCall(F,S,S2,I2,_),
    FunctionParam(F2,S2,P2,I2).
  ```
- **Facts** : existants. Stratification Datalog déjà gérée.
- **Coût** : small (5 lignes Datalog + ratchet).
- **Valeur Sentinel** : 2-4 TPs additionnels au-delà du 1-hop courant.

### 17. composite-fanout-no-test-no-articulation
- **Pattern** : `ModuleFanIn > 15` ∧ `!TestedFile` ∧ `!ArticulationPoint` = paradoxe (tout importe mais personne ne casse). Soit refactor ratchet, soit ajouter tests.
- **Facts** : `ModuleFanIn` + `TestedFile` + `ArticulationPoint`.
- **Inspiration** : Haskell stan "highly-connected unverified module".
- **Coût** : trivial.
- **Valeur Sentinel** : 2-3 TPs (`logger.ts`, `types.ts`, `useSocket.ts` cités sans ADR dans CLAUDE-CONTEXT).

### 18. composite-god-table (aggregate `.count`)
- **Pattern** : table avec > 10 FK incoming = god-table, refactor join-table possible.
- **Facts** : `SqlForeignKey` + `.count`.
- **Coût** : trivial.
- **Valeur Sentinel** : 3 hits (`projects=40`, `project_blocks=16`, `entities=13`).

### 19. composite-fanout-overload (aggregate `.count`)
- **Pattern** : fichier qui importe > 25 modules = god-orchestrator.
- **Facts** : `Imports` + `.count`.
- **Coût** : trivial.
- **Valeur Sentinel** : 2-3 hits (`index.ts=39`, `server.ts=20`, `system.ts`).

### 20. composite-god-function (aggregate `.count`)
- **Pattern** : fonction appelée > 30 fois = couche d'accès cachée. Cas légitime SSOT (`getPool=207`) → grandfather. Suspects : `emit`, `sendError`.
- **Facts** : `SymbolCallEdge` + `.count`.
- **Coût** : small (750 edges actuellement).
- **Valeur Sentinel** : 3 hits (`getPool` legit, `emit` à examiner — devrait passer event-bus typé ADR-017, `sendError`).

### 21. composite-missing-rate-limiting
- **Pattern** : route handler authn-related (`/login`, `/register`) sans middleware `rateLimit|express-rate-limit`.
- **Facts** : `EntryPoint(kind="http-route")` + `SymbolCallEdge` to `rateLimit`. `.count` aggregate.
- **Inspiration** : CodeQL [`js/missing-rate-limiting`](https://github.com/github/codeql/blob/main/javascript/ql/src/Performance/) ; CWE-770.
- **Coût** : small.
- **Valeur Sentinel** : 2 TPs (`api/routes/system.ts`, `api/webhook-api.ts`).

### 22. composite-event-emitter-leak
- **Pattern** : `emitter.on(...)` sans `removeListener` correspondant dans même symbol. `count(on) > count(off)`.
- **Facts** : `SymbolCallEdge` + `.count` aggregate.
- **Inspiration** : Semgrep `unbounded-listeners` ; Node best-practice.
- **Coût** : small.
- **Valeur Sentinel** : 2 TPs probables (`event-bus.ts`, `scheduler.ts`).

### 23. composite-cross-fn-deser-helper
- **Pattern** : webhook → parseHelper avec `JSON.parse`/`yaml.load` du payload tainté. Couvert même si parseHelper ailleurs.
- **Facts** : existants (`TaintedParam` + `TaintSink` deser).
- **Inspiration** : CWE-502 cross-fn.
- **Coût** : trivial.
- **Valeur Sentinel** : 2 TPs (admin.ts re-parse de `data.params`, peer-review JSON.stringify).

### 24. composite-deprecated-on-truth-point-writer
- **Pattern** : un writer SSOT appelle une API `@deprecated` = bombe à retardement.
- **Facts** : `DeprecatedUsage` + `TruthPointWriter`.
- **Inspiration** : Rust `#[deprecated]` + Erlang Dialyzer.
- **Coût** : trivial.
- **Valeur Sentinel** : 1-3 TPs probables (publish-reconciler, vector-store).

### 25. composite-drift-signal-density (aggregate `.count`)
- **Pattern** : fichier avec > 2 `DriftSignalFact` = rot accumule, prioritize maintenance.
- **Facts** : `DriftSignalFact` + `.count`.
- **Coût** : trivial.
- **Valeur Sentinel** : 3-5 TPs estimés sur 28 drift rows total.

### 26. composite-truth-point-asymmetric
- **Pattern** : concept avec writers mais zéro reader (state mort) OU readers sans writer (lecture vide).
- **Facts** : `TruthPointReader` + `TruthPointWriter` (les deux sous-utilisés).
- **Coût** : trivial (anti-join).
- **Valeur Sentinel** : 2-4 TPs.

---

## Tier 16 — high value × medium cost (1-3h, extension extractor légère)

### 27. composite-cross-fn-log-injection (CWE-117)
- **Pattern** : route → service qui logue param tainté. Logger top-hub (in:107) → blast-radius énorme.
- **Facts** : NEW `TaintSink(kind="log")` à ajouter dans `taint-sinks.ts` (detect `logger.*`, `log.*`).
- **Inspiration** : CWE-117 ; OWASP Logging Cheat Sheet.
- **Coût** : medium (extractor side, ~30 lignes).
- **Valeur Sentinel** : 10+ TPs. [kernel/decision-journal.ts:73](sentinel-core/src/kernel/decision-journal.ts:73) (`Erreur du block ${p.blockName}: ${String(p.error)...}`) ; pattern courant.

### 28. composite-cross-fn-taint-reassignment
- **Pattern** : `const x = param; doThing(x)` dans la callee — actuellement non tracé (`composite-cross-function-taint.dl:28`).
- **Facts** : NEW `TaintedVarFromParam(file, sym, varName, source)`.
- **Coût** : medium (extension `tainted-vars.ts` Pass 1).
- **Valeur Sentinel** : 3-5 TPs (helpers Sentinel font souvent `const x = arg`).

### 29. composite-clear-text-logging (CWE-312)
- **Pattern** : `logger.info({ password, apiKey })` — secret loggué en clair.
- **Facts** : NEW kind `log-out` + NEW `SecretVarRef` (variable nommée `password|token|apiKey|secret`).
- **Inspiration** : CodeQL [`js/clear-text-logging`](https://github.com/github/codeql/blob/main/javascript/ql/src/Security/CWE-312/CleartextLogging.ql).
- **Coût** : medium (~50 lignes extractor).
- **Valeur Sentinel** : 2-3 TPs. logger.ts in:107 = surface large.

### 30. composite-crypto-algo-dedicated (CWE-327 propre)
- **Pattern** : V1 detecte md5/sha1 par callee name ; rate `crypto.createHash("md5")` (string arg).
- **Facts** : NEW `CryptoCall(file, line, fn, algo, keyLengthBits)`.
- **Inspiration** : CWE-327 ; CodeQL [`js/weak-cryptographic-algorithm`](https://github.com/github/codeql/blob/main/javascript/ql/src/Security/CWE-327/).
- **Coût** : medium (nouveau extractor `crypto-algo.ts` ~40 lignes, très clonable depuis `eval-calls.ts`).
- **Valeur Sentinel** : 1-3 TPs (signature OAuth/cookies).

### 31. composite-resource-imbalance-cross-fn-pairs
- **Pattern** : `startX` appelé partout où `stopX` n'est pas appelé. Aujourd'hui `no-resource-imbalance.dl:9-13` skip explicite des split start/stop.
- **Facts** : `SymbolCallEdge` + aggregate `.count`.
- **Coût** : medium (rule + ratchet).
- **Valeur Sentinel** : 1-2 TPs (scheduler/healer).

### 32. composite-cross-fn-redirect (CWE-601)
- **Pattern** : route → redirect helper qui set Location header avec input tainté.
- **Facts** : NEW `TaintSink(kind="redirect")`.
- **Inspiration** : CodeQL [`js/server-side-unvalidated-redirect`](https://github.com/github/codeql/blob/main/javascript/ql/src/Security/CWE-601/ServerSideUrlRedirect.ql).
- **Coût** : medium (NEW sink kind).
- **Valeur Sentinel** : 1 TP marginal mais préventif.

### 33. composite-cors-misconfig (CWE-942)
- **Pattern** : `cors({ origin: '*' })` ou `origin: req.headers.origin` (reflective).
- **Facts** : NEW `CorsConfig(file, line, originKind)` extractor (~25 LOC).
- **Inspiration** : CodeQL [`js/cors-misconfiguration`](https://github.com/github/codeql/blob/main/javascript/ql/src/Security/CWE-942/CorsMisconfiguration.ql).
- **Coût** : small.
- **Valeur Sentinel** : 1 TP.

### 34. composite-disabling-cert-validation (CWE-295)
- **Pattern** : `rejectUnauthorized: false` ou `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- **Facts** : NEW `TlsConfigUnsafe(file, line, key)` ~20 LOC.
- **Inspiration** : CodeQL [`js/disabling-certificate-validation`](https://github.com/github/codeql/blob/main/javascript/ql/src/Security/CWE-295/DisablingCertificateValidation.ql).
- **Coût** : small.
- **Valeur Sentinel** : 1 TP (gmail-utils, MCP HTTPS clients).

### 35. composite-insecure-randomness (CWE-338)
- **Pattern** : `Math.random()` utilisé pour token/secret/sessionId/nonce.
- **Facts** : NEW `WeakRandomCall(file, line, contextName)` extractor.
- **Inspiration** : CodeQL [`js/insecure-randomness`](https://github.com/github/codeql/blob/main/javascript/ql/src/Security/CWE-338/InsecureRandomness.ql).
- **Coût** : medium (~30 LOC extractor).
- **Valeur Sentinel** : 1-2 TPs (kernel/agent-commit, oauth flows).

---

## Tier 17 — needs new fact emitter (small, snapshot data déjà calculée)

> Le snapshot calcule déjà ces signaux, il manque juste un emit côté
> `packages/codegraph/src/facts/index.ts` (~10-15 lignes par fact).

### 36. composite-FSM-ORPHAN
- **Pattern** : état FSM déclaré dans union/enum mais jamais écrit. Détecté en synopsis (5 cas Sentinel : `DeployLogPhase` × {build,up,done,stage,sync}).
- **Facts requis** : NEW `FsmStateDeclared(concept, state, file)` + `FsmStateWritten(concept, state, file, line)` à émettre depuis `state-machines.ts` (déjà calculés).
- **Coût** : medium côté toolkit (fact emitter), trivial côté rule.
- **Valeur Sentinel** : 5 grandfathered + force complétion ou suppression future.

### 37. composite-BACK-EDGE
- **Pattern** : edge d'import qui inverse l'ordre architectural (`kernel → blocks`, `project-manager → memory`). 5 imports concrets dans Sentinel.
- **Facts requis** : NEW `LayerOrder(layer, rank)` + `FileLayer(file, layer)` (dérivable du préfixe path).
- **Inspiration** : Bazel `layering_check`.
- **Coût** : medium (force décision ADR sur layering — c'est aussi sa valeur).
- **Valeur Sentinel** : **highest architectural value** — formalise un anti-pattern silencieux.

### 38. composite-DEP-UNUSED
- **Pattern** : entrée `package.json` jamais importée. 5 cas Sentinel.
- **Facts requis** : NEW `PackageDepDeclared(json, depName, kind)` (extractor `package-deps.ts` existe).
- **Coût** : small.
- **Valeur Sentinel** : 5 ratchet items (4 CLI tools probablement à grandfather, `@tailwindcss/postcss` à examiner).

### 39. composite-BARREL-LOW
- **Pattern** : `index.ts` à ≤2 re-exports et ≤1 consumer = friction sans bénéfice. 3 cas Sentinel.
- **Facts requis** : NEW `Barrel(file, reExportCount, consumerCount, lowValue)` (déjà calculé).
- **Coût** : small.
- **Valeur Sentinel** : 3 ratchet ; bloque prolifération future.

### 40. composite-event-orphan + listener-orphan
- **Pattern** : emit sans listener = event mort ; subscribe sans émetteur = code mort. Aujourd'hui impossible (asymétrie : on a `EmitsLiteral`/`EmitsConstRef`, pas `ReceivesEvent`).
- **Facts requis** : NEW `EventListener(file, line, eventName)` (~80 lignes mirror du scan emit dans `event-emit-sites.ts`).
- **Inspiration** : ADR-004 cross-block.
- **Coût** : medium (extractor extension), trivial pour rule après.
- **Valeur Sentinel** : élevée — **gros gap architectural**.

### 41. composite-dead-export-in-hub
- **Pattern** : export non utilisé colocalisé dans un truth-point writer = drift d'API publique.
- **Facts requis** : NEW `UnusedExport(file, name, line)` (déjà détecté hook PostToolUse "safe-to-remove").
- **Coût** : small (~10 lignes facts/index.ts).
- **Valeur Sentinel** : 5+ TPs probables.

### 42. composite-magic-in-resource-thresholds
- **Pattern** : magic number dans `shared/resource-thresholds.ts` ou `shared/timeout-config.ts` = violation indirecte ADR-013/015/019.
- **Facts requis** : NEW `MagicNumber(file, line, value, containingSymbol)` (extractor existe).
- **Coût** : small.
- **Valeur Sentinel** : 2-4 TPs.

### 43. composite-long-fn-in-truth-point-writer
- **Pattern** : fonction ≥ 80 LOC dans un writer SSOT = refactor priorisé.
- **Facts requis** : NEW `LongFunction(file, name, line, locCount, complexity)` (extractor existe).
- **Coût** : small.
- **Valeur Sentinel** : 3+ TPs.

### 44. composite-ReDoS via regex-source extractor
- **Pattern** : regex avec nested quantifiers `(.+)+` ou `(a|a)*` → catastrophic backtracking.
- **Facts requis** : NEW extractor `regex-source.ts` (~50 LOC). Émet `RegexLiteral(file, line, source, flags)` + `RegexConstructed(file, line, sourceTainted)`.
- **Inspiration** : CodeQL [`js/regex-injection`](https://github.com/github/codeql/blob/main/javascript/ql/src/Security/CWE-1333/RegExpInjection.ql) ; safe-regex.
- **Coût** : small (extractor) + small (rule).
- **Valeur Sentinel** : 0-1 TP probable mais préventif anti-DoS.

### 45. composite-silent-error via try-catch extractor
- **Pattern** : try/catch dont le block catch est vide ou ne fait que log sans rethrow.
- **Facts requis** : NEW extractor `try-catch.ts` (~50 LOC). Émet `TryCatchClause(file, line, hasCatch, catchKind)`.
- **Inspiration** : ESLint `no-empty-pattern` étendu.
- **Coût** : small + small.
- **Valeur Sentinel** : 3-5 TPs probables.

### 46. composite-N+1-await via await-in-loop extractor
- **Pattern** : `await` dans `for`/`while`/`forOf` direct (pas dans fn nested) = sequential I/O bottleneck.
- **Facts requis** : NEW extractor `await-in-loop.ts` (~35 LOC).
- **Inspiration** : ESLint `no-await-in-loop`.
- **Coût** : small.
- **Valeur Sentinel** : 2-4 TPs (batch jobs, scheduler).

---

## Tier 18 — speculative / large effort (transitive closure ou extractor lourd)

### 47. composite-multi-hop-route-service-repo-sql
- **Why** : pattern Sentinel typique = route → kernel/* service → memory/vector-store getPool().query() (2-3 hops). Tier 14 1-hop manque la chaîne.
- **Effort** : medium côté Datalog (transitive closure de `TaintedParam` avec depth≤3), nécessite tests anti-explosion.
- **Sentinel example** : `api/routes/improvement.ts:46 → kernel/improvement-engine? → memory/vector-store.ts:queryByEmbedding` ; `webhooks/admin.ts:executeAdminCommand → block-runtime.stopAll`.

### 48. composite-multi-hop-cmd-via-shared-util
- **Why** : `shared/ffmpeg.ts:spawn` appelé depuis `packs/visual-render/blocks/transcoder.ts` lui-même appelé par scheduler = 3 hops.
- **Effort** : medium (même algo que #47).

### 49. composite-event-payload-cross-block-taint
- **Why** : event-bus découple emitter et listener. Besoin de `EventPayloadFlow(emit_file, listen_file, eventType)` joint avec taint des deux côtés.
- **Effort** : large (NEW fact provenance + multi-relation).
- **Sentinel example** : `webhooks/admin.ts:executeAdminCommand` → `event-bus.emit({payload: data.params})` → `kernel/decision-journal.ts:handleApprovalResolved` → `db.query`.

### 50. composite-multi-hop-deser-with-shape-checker
- **Why** : `validateBody` appelé en haut, sanitization passée à travers N fonctions intermédiaires. File-level rule perd la trace = faux positifs.
- **Effort** : large (CodeQL `barrier` concept à implémenter).

### 51. composite-fsm-transitions-reconstruction
- **Why** : V2 du FSM detector — reconstruire les transitions (read state X → write state Y). Aujourd'hui v0.3.0 capture juste write sites.
- **Effort** : large (CFG + state-var tracking).
- **Valeur** : débloque 5 FSM-ORPHAN avec contexte complet.

### 52. composite-data-flows-container-aware
- **Why** : marqueur explicite `data-flows.ts:817` ("void ranges // placeholder pour future détection container-aware"). Variable `ranges` calculée mais unused.
- **Effort** : medium-large (intent à confirmer avant code).

---

## Skipped — pas la peine

### Déjà couverts par rules existantes
- **CWE-022 / 078 / 079 / 089 / 327 / 502 / 918 / 1321** : ports V1 déjà shippés Tiers 13-14. Les composites cross-fn ci-dessus (#1, #3, #6, etc.) sont les V2 cross-fn, pas des doublons.
- **React `dangerouslySetInnerHTML`** : couvert par `cwe-079-xss.dl` via `html-out` sink.
- **CodeQL `js/code-injection` générique** : couvert par `no-eval.dl` + `composite-eval-in-http-route.dl`.

### Pas le bon outil
- **CWE-367 TOCTOU file-system-race** : nécessite ordering temporal CFG-stable, faux positifs élevés.
- **CodeQL `js/incomplete-url-substring-sanitization`** : pure data-flow string-equality, Datalog sans string-ops manque cuisson.
- **CodeQL `js/clear-text-storage` (localStorage)** : Sentinel = backend Node, surface négligeable.
- **SQL covering-index** : demande EXPLAIN runtime, pas analyse statique.

### Couverts par TypeScript strict
- **Rust use-after-move** : partiellement par resource-imbalance + tsc.
- **Ada uninitialized-variable** : tsc `useBeforeAssigned`.
- **Go SA4006 ineffective assignment** : tsc `noUnusedLocals`.
- **OCaml exhaustive-match** : partiel via `no-switch-empty-or-no-default.dl`.
- **Haskell redundant bracket** : prettier/eslint zone.

### Précision marginale (rules existantes déjà OK)
- **composite-cwe-079-xss-template-engine-auto-escape** ([cwe-079-xss.dl:16](sentinel-core/invariants/cwe-079-xss.dl)) : split `html-out` en `template`/`raw` = precision win uniquement, pas TP gain.
- **composite-cwe-089-sql-parameterized-vs-concat-distinction** ([cwe-089-sql-injection.dl:11-13](sentinel-core/invariants/cwe-089-sql-injection.dl)) : précision sur `db.query(sql, [params])` vs `db.query(${userId})` = win précision, pas TP.
- **composite-eval-in-http-route-tighten-via-cross-fn** : 0 TP Sentinel (pas d'eval), juste durcir la rule.
- **composite-jwt-none-alg / hardcoded-jwt-secret / eval-via-settimeout-string / tar-slip** : surfaces minuscules, défensifs uniquement.

### Préventifs pure (0 TP actuel)
- **composite-truth-point-spread** (Fil 5 #2) : max=3 sur `trust_scores`, 0 violation.
- **composite-cycle-size > 3** : max actuel = 3, 0 hit.
- **composite-fk-no-pk-target** : 0-2 TPs estimés, faible.
- **composite-fk-composite-multi-column** : 0 sur Sentinel (FKs simples).

---

## Synthèse priorisation

**Top 10 ROI immédiat** (PRs à ouvrir cette semaine) :

| # | Rule | Coût | Valeur Sentinel |
|---|---|---|---|
| 1 | composite-cross-fn-sql-injection | trivial | 3+ TPs réels (admin.ts:151) |
| 2 | composite-cross-fn-cmd-injection | small | 5 TPs réels (system.ts:341) |
| 3 | composite-tainted-vars-destructuring | small | 5-10 TPs |
| 4 | composite-tainted-flow-stricter-var-level | small | precision ÷10 |
| 5 | composite-truth-point-god-reader | trivial | 6 TPs confirmés |
| 6 | composite-long-function-by-params | trivial | 10+ TPs |
| 7 | composite-fat-table | trivial | 6 TPs |
| 8 | composite-env-var-spread | trivial | 7+ TPs |
| 9 | composite-hub-untested | trivial | 4 TPs |
| 10 | composite-cross-pack-bypass | trivial | 5+ TPs ADR-004 |

**Tiers 15+16** : 35 candidats avec facts existants ou extension légère.
**Tier 17** : 11 candidats nécessitent un nouveau fact emitter (snapshot data déjà là).
**Tier 18** : 6 candidats spéculatifs (transitive closure / barrier / CFG).
**Skipped** : ~15 raisons documentées.

**Total : 52 candidats actionnables identifiés.**

Le plus gros gap structurel détecté : pas de fact `EventListener` symétrique de `EmitsLiteral` (Fil 2 missing #1) — bloque toute analyse event-orphan et casse l'invariant ADR-004 à la racine. À prioriser comme dette d'extractor.
