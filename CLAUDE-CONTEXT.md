<!-- AUTO-GÉNÉRÉ par @liby-tools/adr-toolkit — NE PAS éditer à la main -->

# Boot Brief — codegraph-toolkit

> **À lire AVANT toute action.** Ce fichier est le state-of-the-architecture.
> Si tu modifies un fichier listé dans "Fichiers gouvernés par un ADR" ci-dessous,
> lis l'ADR correspondant AVANT d'éditer.

## Règles architecturales actives (ADRs)

- **ADR-001** — Le synopsis builder (`@liby-tools/codegraph buildSynopsis`) ne fait aucun I/O, > n'invoque aucun LLM, n'utilise aucune source non-déterministe. Même > snapshot d'entrée → même output JSON byte-équivalent.
  → [`Synopsis builder = pur, zéro LLM`](docs/adr/001-synopsis-builder-pure.md)
- **ADR-002** — Aucun path / nom de projet consommateur (Sentinel, Morovar, etc.) ne > doit apparaître dans le code des packages `@liby-tools/codegraph` ou > `@liby-tools/adr-toolkit`. Tout vient de `.codegraph-toolkit.json` ou > `codegraph.config.json` chargés depuis le rootDir du consommateur.
  → [`Config-driven obligatoire — pas de hardcoded projet dans le code des packages`](docs/adr/002-config-driven-no-hardcoded-projects.md)
- **ADR-003** — Le default detector set (`createDetectors([])` ou `defaultDetectorNames()`) > exclut tous les détecteurs marqués `projectSpecific: true`. Pour les > activer, le consommateur doit les nommer explicitement dans > `codegraph.config.json` → `"detectors": [...]`.
  → [`Détecteurs généralistes par défaut, project-specific opt-in`](docs/adr/003-detectors-generaliste-vs-project-specific.md)
- **ADR-004** — Le bootstrap agentique sépare 3 rôles, et aucun ne franchit son périmètre : > > 1. **OÙ regarder** : codegraph + pattern detectors (déterministe). Le > LLM ne décide jamais quels fichiers méritent un ADR. > 2. **COMMENT formuler** : un agent Sonnet par candidat avec prompt > cadré et output JSON forcé. Le LLM rédige Rule + Why + asserts depuis > le code, rien d'autre. > 3. **QUOI accepter** : humain (CLI revue + `--apply` confirmé). Les > ADRs sont écrits avec `Status: Proposed`, jamais `Accepted`.
  → [`Bootstrap = 3 rôles séparés (codegraph détecte / LLM rédige / humain valide)`](docs/adr/004-bootstrap-trois-roles-separes.md)
- **ADR-005** — Tout détecteur codegraph qui scanne des fichiers TS expose 4 éléments : > 1. Un helper pure `extractXxxFileBundle(sf, relPath, rootDir, project?)` > qui dérive un bundle sérialisable d'UN seul SourceFile. > 2. Si l'agrégation est non-triviale, un helper pure > `aggregateXxxBundles(bundlesByFile)` qui fusionne sans I/O ni AST. > 3. Une fonction batch publique `analyzeXxx(rootDir, files, ...)` qui > compose les deux ci-dessus en boucle (chemin legacy préservé). > 4. Un wrapper Salsa dans `incremental/xxx.ts` exposant > `xxxBundleOfFile(path)` (derived sur `fileContent`) + > `allXxx(label)` (derived qui agrège). > > Aucun détecteur ne mélange I/O async + AST walk + agrégation globale dans > une même fonction batch monolithique.
  → [`Pattern détecteurs codegraph — bundle per-file + agrégat pure`](docs/adr/005-detector-pattern-bundle-per-file.md)
- **ADR-006** — `packages/codegraph/src/core/types.ts` est importé par 57+ fichiers > (top hub absolu du toolkit). Tout type exporté depuis ce fichier est > un contrat avec : > - Les détecteurs (extractors/) qui produisent ces structures > - Les consumers (synopsis/, facts/, diff/, check/) qui les lisent > - Le snapshot.json sérialisé sur disque (consommé par Sentinel, > codegraph-mcp, hooks bash, possibles consumers externes) > > RÈGLE : pas de breaking change sans deprecation explicite. On ajoute > des champs optionnels, on ne supprime ni ne modifie la sémantique > d'un champ existant.
  → [``core/types.ts` est le contract canonique — modifications conservatrices uniquement`](docs/adr/006-core-types-canonical-contract.md)
- **ADR-007** — `incremental/queries.ts` et `incremental/database.ts` sont les **points > d'entrée canoniques** pour toute computation incrémentale Salsa. Ne JAMAIS > instancier `new SalsaDatabase()` ailleurs (cassérait le caching). Toujours > consommer la `sharedDb` exportée + déclarer les inputs via les `input()` de > `queries.ts`. Les `derived()` consument fileContent / projectFiles, pas le > filesystem direct.
  → [`Salsa incremental — fileContent + sharedDb sont contrats canoniques`](docs/adr/007-salsa-incremental-contracts.md)
- **ADR-008** — Tout nouveau détecteur (`extends BaseDetector`) DOIT être enregistré dans > `core/detector-registry.ts` via `createDetectors()`. Pas de détecteur > instancié ailleurs (analyzer.ts ne fait QUE consommer le registry). La > propriété `projectSpecific: true` exclut le détecteur de la liste par > défaut — opt-in explicite via config.
  → [`detector-registry est le SEUL point d'enregistrement de détecteurs`](docs/adr/008-detector-registry-canonical.md)
- **ADR-009** — `packages/runtime-graph/src/core/types.ts` est le contract entre 4 > couches : (1) capture (OTel attach), (2) aggregator (spans → facts), > (3) exporter (facts → TSV/datalog), (4) datalog rules. Modifications > conservatrices uniquement — ajout de champs optionnels OK, suppression > ou changement de sémantique = breaking. Aligned with ADR-006 pour > `codegraph/core/types.ts`.
  → [`runtime-graph/core/types.ts = contrat canonique runtime`](docs/adr/009-runtime-graph-types-contract.md)
- **ADR-010** — Le package `@liby-tools/datalog` est un interpréteur Datalog pure-TS, > ZÉRO binary externe (pas de Soufflé, pas de native node modules). > Le runtime DOIT être déterministe : même program + same facts = > même output, byte-pour-byte. La canonicalisation des relations passe > par `canonical.ts` (sort lex). Le parser `parser.ts` ne fait aucun I/O.
  → [`Datalog runtime — pure-TS, deterministic, zero binary`](docs/adr/010-datalog-pure-deterministic.md)
- **ADR-011** — Le pipeline runtime capture est en 2 couches strictement séparées : > (1) `otel-attach.ts` configure OTel SDK + auto-instruments + collect > les spans en mémoire ; (2) `span-aggregator.ts` projette les spans > ReadableSpan vers les facts canoniques (HttpRouteHit, DbQueryExecuted, > etc.). **Aucun mélange** : l'attach ne projette pas, l'aggregator ne > touche pas l'OTel SDK. Un span sans attribute matchant est ignoré.
  → [`runtime-graph capture pipeline — OTel attach + span-to-fact projection`](docs/adr/011-runtime-graph-capture-pipeline.md)
- **ADR-012** — Les helpers ts-morph utilisés par 2+ extractors vivent dans > `packages/codegraph/src/extractors/_shared/`. Pas de duplication > ad-hoc dans les extractors individuels. Les fonctions `_shared/` > sont **pures** (SourceFile in, donnée out — pas d'I/O, pas d'état).
  → [`Extractors `_shared/` — helpers ts-morph mutualisés`](docs/adr/012-extractor-shared-helpers.md)

## Fichiers gouvernés par un ADR (lookup pré-calculé)

- `packages/adr-toolkit/src/bootstrap-fsm.ts` → ADR-004
- `packages/adr-toolkit/src/bootstrap-writer.ts` → ADR-004
- `packages/adr-toolkit/src/bootstrap.ts` → ADR-004
- `packages/adr-toolkit/src/check-asserts.ts` → ADR-002
- `packages/adr-toolkit/src/config.ts` → ADR-002
- `packages/codegraph-mcp/src/snapshot-loader.ts` → ADR-008
- `packages/codegraph/src/check/types.ts` → ADR-006
- `packages/codegraph/src/cli/_shared.ts` → ADR-005
- `packages/codegraph/src/cli/commands/analyze.ts` → ADR-005
- `packages/codegraph/src/cli/commands/datalog-check.ts` → ADR-005
- `packages/codegraph/src/cli/commands/diff.ts` → ADR-005
- `packages/codegraph/src/core/analyzer.ts` → ADR-008
- `packages/codegraph/src/core/detector-registry.ts` → ADR-008
- `packages/codegraph/src/core/detectors/barrels-detector.ts` → ADR-008
- `packages/codegraph/src/core/detectors/complexity-detector.ts` → ADR-008
- `packages/codegraph/src/core/detectors/cross-discipline-detector.ts` → ADR-008
- `packages/codegraph/src/core/detectors/cycles-detector.ts` → ADR-008
- `packages/codegraph/src/core/detectors/data-flows-detector.ts` → ADR-008
- `packages/codegraph/src/core/detectors/drizzle-schema-detector.ts` → ADR-008
- `packages/codegraph/src/core/detectors/env-usage-detector.ts` → ADR-008
- `packages/codegraph/src/core/detectors/event-emit-sites-detector.ts` → ADR-008
- `packages/codegraph/src/core/detectors/oauth-scope-literals-detector.ts` → ADR-008
- `packages/codegraph/src/core/detectors/package-deps-detector.ts` → ADR-008
- `packages/codegraph/src/core/detectors/sql-schema-detector.ts` → ADR-008
- `packages/codegraph/src/core/detectors/state-machines-detector.ts` → ADR-008
- `packages/codegraph/src/core/detectors/symbol-refs-detector.ts` → ADR-008
- `packages/codegraph/src/core/detectors/taint-detector.ts` → ADR-008
- `packages/codegraph/src/core/detectors/truth-points-detector.ts` → ADR-008
- `packages/codegraph/src/core/detectors/typed-calls-detector.ts` → ADR-008
- `packages/codegraph/src/core/detectors/unused-exports-detector.ts` → ADR-008
- `packages/codegraph/src/core/file-discovery.ts` → ADR-008
- `packages/codegraph/src/core/graph.ts` → ADR-008
- `packages/codegraph/src/core/types.ts` → ADR-006
- `packages/codegraph/src/detectors/block-loader.ts` → ADR-003
- `packages/codegraph/src/detectors/index.ts` → ADR-003
- `packages/codegraph/src/detectors/ts-imports.ts` → ADR-008
- `packages/codegraph/src/diff/types.ts` → ADR-006
- `packages/codegraph/src/extractors/_internal/code-quality/_helpers.ts` → ADR-005
- `packages/codegraph/src/extractors/_shared/ast-helpers.ts` → ADR-012
- `packages/codegraph/src/extractors/_shared/sql-helpers.ts` → ADR-012
- `packages/codegraph/src/extractors/_shared/sql-types.ts` → ADR-012
- `packages/codegraph/src/extractors/co-change.ts` → ADR-005
- `packages/codegraph/src/extractors/compression-similarity.ts` → ADR-005
- `packages/codegraph/src/extractors/constant-expressions.ts` → ADR-005
- `packages/codegraph/src/extractors/eslint-import.ts` → ADR-005
- `packages/codegraph/src/extractors/package-deps.ts` → ADR-005
- `packages/codegraph/src/extractors/sql-schema.ts` → ADR-005
- `packages/codegraph/src/extractors/state-machines.ts` → ADR-005
- `packages/codegraph/src/extractors/tainted-vars.ts` → ADR-007
- `packages/codegraph/src/extractors/unused-exports.ts` → ADR-005
- `packages/codegraph/src/facts/index.ts` → ADR-010
- `packages/codegraph/src/incremental/arguments.ts` → ADR-007
- `packages/codegraph/src/incremental/barrels.ts` → ADR-007
- `packages/codegraph/src/incremental/boolean-params.ts` → ADR-007
- `packages/codegraph/src/incremental/co-change.ts` → ADR-007
- `packages/codegraph/src/incremental/code-quality-patterns.ts` → ADR-007
- `packages/codegraph/src/incremental/complexity.ts` → ADR-007
- `packages/codegraph/src/incremental/compression-similarity.ts` → ADR-007
- `packages/codegraph/src/incremental/constant-expressions.ts` → ADR-007
- `packages/codegraph/src/incremental/crypto-algo.ts` → ADR-007
- `packages/codegraph/src/incremental/cycles.ts` → ADR-007
- `packages/codegraph/src/incremental/data-flows.ts` → ADR-007
- `packages/codegraph/src/incremental/database.ts` → ADR-007
- `packages/codegraph/src/incremental/dead-code.ts` → ADR-007
- `packages/codegraph/src/incremental/deprecated-usage.ts` → ADR-007
- `packages/codegraph/src/incremental/drift-patterns.ts` → ADR-007
- `packages/codegraph/src/incremental/env-usage.ts` → ADR-007
- `packages/codegraph/src/incremental/eval-calls.ts` → ADR-007
- `packages/codegraph/src/incremental/event-emit-sites.ts` → ADR-007
- `packages/codegraph/src/incremental/function-complexity.ts` → ADR-007
- `packages/codegraph/src/incremental/hardcoded-secrets.ts` → ADR-007
- `packages/codegraph/src/incremental/magic-numbers.ts` → ADR-007
- `packages/codegraph/src/incremental/metrics.ts` → ADR-007
- `packages/codegraph/src/incremental/oauth-scope-literals.ts` → ADR-007
- `packages/codegraph/src/incremental/package-deps.ts` → ADR-007
- `packages/codegraph/src/incremental/persistence.ts` → ADR-007
- `packages/codegraph/src/incremental/project-cache.ts` → ADR-007
- `packages/codegraph/src/incremental/queries.ts` → ADR-007
- `packages/codegraph/src/incremental/resource-balance.ts` → ADR-007
- `packages/codegraph/src/incremental/sanitizers.ts` → ADR-007
- `packages/codegraph/src/incremental/security-patterns.ts` → ADR-007
- `packages/codegraph/src/incremental/state-machines.ts` → ADR-007
- `packages/codegraph/src/incremental/symbol-refs.ts` → ADR-007
- `packages/codegraph/src/incremental/taint-sinks.ts` → ADR-007
- `packages/codegraph/src/incremental/taint.ts` → ADR-007
- `packages/codegraph/src/incremental/tainted-vars.ts` → ADR-007
- `packages/codegraph/src/incremental/truth-points.ts` → ADR-007
- `packages/codegraph/src/incremental/ts-imports.ts` → ADR-007
- `packages/codegraph/src/incremental/typed-calls.ts` → ADR-007
- `packages/codegraph/src/incremental/unused-exports.ts` → ADR-007
- `packages/codegraph/src/incremental/watcher.ts` → ADR-007
- `packages/codegraph/src/map/dsm-renderer.ts` → ADR-008
- `packages/codegraph/src/memory/store.ts` → ADR-002
- `packages/codegraph/src/synopsis/builder.ts` → ADR-001
- `packages/codegraph/src/synopsis/tensions.ts` → ADR-001
- `packages/datalog/src/canonical.ts` → ADR-010
- `packages/datalog/src/facts-loader.ts` → ADR-010
- `packages/datalog/src/parser.ts` → ADR-010
- `packages/datalog/src/runner.ts` → ADR-010
- `packages/datalog/src/types.ts` → ADR-010
- `packages/runtime-graph/src/capture/auto-bootstrap.ts` → ADR-011
- `packages/runtime-graph/src/capture/otel-attach.ts` → ADR-011
- `packages/runtime-graph/src/capture/span-aggregator.ts` → ADR-011
- `packages/runtime-graph/src/core/types.ts` → ADR-009
- `packages/runtime-graph/src/drivers/_common.ts` → ADR-011
- `packages/runtime-graph/src/drivers/chaos.ts` → ADR-011
- `packages/runtime-graph/src/drivers/replay-tests.ts` → ADR-011
- `packages/runtime-graph/src/drivers/synthetic.ts` → ADR-011
- `packages/runtime-graph/src/facts/exporter.ts` → ADR-011
- `packages/runtime-graph/src/metrics/runtime-disciplines.ts` → ADR-011
- `packages/salsa/src/types.ts` → ADR-006
- `scripts/scaffold-salsa.sh` → ADR-007

> **Dogfooding** : ce repo gouverne sa propre architecture via le toolkit qu'il publie. Les 4 ADRs ci-dessus encadrent les invariants critiques (zéro LLM dans synopsis, config-driven, séparation détecteurs, 3 rôles bootstrap).

## Tests d'invariant qui gardent ces règles

- `packages/*/tests/*.test.ts`

## Top hubs (fichiers les plus importés — gros risque de régression si touchés)

- `packages/codegraph/src/core/types.ts` (in: 79) · gov by ADR-006
- `packages/codegraph/src/incremental/queries.ts` (in: 41) · gov by ADR-007
- `packages/codegraph/src/incremental/database.ts` (in: 39) · gov by ADR-007
- `packages/salsa/dist/index.d.ts` (in: 38)
- `packages/codegraph/src/extractors/_shared/ast-helpers.ts` (in: 25) · gov by ADR-012
- `packages/codegraph/src/core/detector-registry.ts` (in: 19) · gov by ADR-008
- `packages/runtime-graph/src/core/types.ts` (in: 13) · gov by ADR-009
- `packages/adr-toolkit/src/config.ts` (in: 10) · gov by ADR-002

## ⚠ ADR anchor suggestions

Fichiers load-bearing (in-degree élevé ou truth-point) **sans aucun marqueur `// ADR-NNN`** dans le code. Intentionnel ? Sinon poser un marqueur ou créer un ADR :

- **38** `packages/salsa/dist/index.d.ts` _(top-hub)_

## Tensions actives — invitations à explorer

> Convocations courtes pointant vers des frictions détectées dans le code.
> Chaque tension a un **test rapide** pour trancher : hypothèse à vérifier,
> pas verdict. Une tension non explorée n'est pas un bug — c'est un saut
> latéral possible que le sol stable rend testable.

- **ORPHELIN** `packages/datalog/src/cli.ts` — aucun importeur  
  _→ supprimer + npm test : si vert → mort, si rouge → entry-point caché_
- **ORPHELIN** `packages/runtime-graph/src/cli.ts` — aucun importeur  
  _→ supprimer + npm test : si vert → mort, si rouge → entry-point caché_
- **ORPHELIN** `packages/runtime-graph/src/capture/auto-bootstrap.ts` — aucun importeur  
  _→ supprimer + npm test : si vert → mort, si rouge → entry-point caché_
- **ORPHELIN** `packages/codegraph/tests/fixtures/cycles/a.ts` — aucun importeur  
  _→ supprimer + npm test : si vert → mort, si rouge → entry-point caché_
- **ORPHELIN** `packages/codegraph/tests/fixtures/cycles/b.ts` — aucun importeur  
  _→ supprimer + npm test : si vert → mort, si rouge → entry-point caché_
- **DEP-UNUSED** `jest` — déclaré dans packages/codegraph/tests/fixtures/package-deps/package.json, jamais importé  
  _→ npm uninstall jest + npm test_
- **DEP-UNUSED** `test-only-in-deps` — déclaré dans packages/codegraph/tests/fixtures/package-deps/package.json, jamais importé  
  _→ npm uninstall test-only-in-deps + npm test_
- **DEP-UNUSED** `unused-pkg` — déclaré dans packages/codegraph/tests/fixtures/package-deps/package.json, jamais importé  
  _→ npm uninstall unused-pkg + npm test_
- **BARREL-LOW** `packages/adr-toolkit/src/index.ts` — barrel à 15 re-export(s) pour 0 consumer(s)  
  _→ inline les imports + supprimer le barrel_
- **BARREL-LOW** `packages/codegraph/src/index.ts` — barrel à 8 re-export(s) pour 0 consumer(s)  
  _→ inline les imports + supprimer le barrel_
- **BARREL-LOW** `packages/codegraph/tests/fixtures/package-deps/src/barrel.ts` — barrel à 2 re-export(s) pour 1 consumer(s)  
  _→ inline les imports + supprimer le barrel_
- **BARREL-LOW** `packages/datalog/src/index.ts` — barrel à 13 re-export(s) pour 0 consumer(s)  
  _→ inline les imports + supprimer le barrel_
- **BARREL-LOW** `packages/runtime-graph/src/capture/index.ts` — barrel à 3 re-export(s) pour 0 consumer(s)  
  _→ inline les imports + supprimer le barrel_

## Activité récente (14 derniers jours)

```
2a7d3cf fix(codegraph): bayesian-cochange reads param, not snapshot — 0 → 175 rows
4db23a0 feat(canary-project): expand to 51/83 (61%) fact coverage
c41f911 feat(examples): canary-project ground-truth fixture for codegraph
cbb861f fix(runtime-graph): ESM project capture + ground-truth fixture
f4d87b3 chore(packages): strip leading './' from bin paths
acd31ff feat(codegraph): bin-shebangs detector — publish hygiene
da5f643 chore(invariants-postgres-ts): bump codegraph/datalog peer dep ^0.2.0 → ^0.3.0
ca5ec9f chore(codegraph-mcp): bump 0.2.0 → 0.3.0 (align workspace)
9c34a58 chore(release): hygiène 0.3.0 — INDEX auto-régen, LICENSE, CI, ADR drift gate
edb3764 refactor(toolkit): zero drift signals — 23 → 0 (-100%)
8374745 refactor(datalog): split Lexer.readString (cyclo 10→4, cog 26→3) — parser.ts cleared
0796ef1 refactor(codegraph): split extractAllocationInLoops (cyclo 11→4, cog 27→6) — allocation-in-loop.ts cleared
```

## Comment contribuer à ce brief

- Une nouvelle décision architecturale ? Crée un ADR via le template :
  `@liby-tools/adr-toolkit/templates/_TEMPLATE.md`
- Le brief sera régénéré au prochain commit.
- Pour forcer une régen : `npx @liby-tools/adr-toolkit brief`
