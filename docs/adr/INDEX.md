# ADR Index — règles qui mordent

> **À LIRE en début de session.** Chaque ligne = une règle architecturale active.
> Si tu touches un fichier listé dans "Anchored in", lis l'ADR correspondant.
> Format ADR : voir `_TEMPLATE.md`.

<!-- AUTO-GÉNÉRÉ depuis docs/adr/NNN-*.md. NE PAS éditer la table à la main. -->

## Conventions

| ADR | Règle qui mord | Anchored in |
|---|---|---|
| [001](001-synopsis-builder-pure.md) | Le synopsis builder (`@liby-tools/codegraph buildSynopsis`) ne fait aucun I/O, n'invoque aucun LLM, n'utili... | `packages/codegraph/src/synopsis/builder.ts`, `packages/codegraph/src/synopsis/tensions.ts` |
| [002](002-config-driven-no-hardcoded-projects.md) | Aucun path / nom de projet consommateur (Sentinel, Morovar, etc.) ne doit apparaître dans le code des packa... | `packages/adr-toolkit/src/check-asserts.ts`, `packages/adr-toolkit/src/config.ts` +1 |
| [003](003-detectors-generaliste-vs-project-specific.md) | Le default detector set (`createDetectors([])` ou `defaultDetectorNames()`) exclut tous les détecteurs marq... | `packages/codegraph/src/detectors/block-loader.ts`, `packages/codegraph/src/detectors/index.ts` |
| [004](004-bootstrap-trois-roles-separes.md) | Le bootstrap agentique sépare 3 rôles, et aucun ne franchit son périmètre : > 1. **OÙ regarder** : codegrap... | `packages/adr-toolkit/src/bootstrap-fsm.ts`, `packages/adr-toolkit/src/bootstrap-writer.ts` +1 |
| [005](005-detector-pattern-bundle-per-file.md) | Tout détecteur codegraph qui scanne des fichiers TS expose 4 éléments : 1. Un helper pure `extractXxxFileBu... | `packages/codegraph/src/cli/_shared.ts`, `packages/codegraph/src/cli/commands/analyze.ts` +11 |
| [006](006-core-types-canonical-contract.md) | `packages/codegraph/src/core/types.ts` est importé par 57+ fichiers (top hub absolu du toolkit). Tout type ... | `packages/codegraph/src/check/types.ts`, `packages/codegraph/src/core/types.ts` +2 |
| [007](007-salsa-incremental-contracts.md) | `incremental/queries.ts` et `incremental/database.ts` sont les **points d'entrée canoniques** pour toute co... | `packages/codegraph/src/extractors/tainted-vars.ts`, `packages/codegraph/src/incremental/arguments.ts` +40 |
| [008](008-detector-registry-canonical.md) | Tout nouveau détecteur (`extends BaseDetector`) DOIT être enregistré dans `core/detector-registry.ts` via `... | `packages/codegraph-mcp/src/snapshot-loader.ts`, `packages/codegraph/src/core/analyzer.ts` +22 |
| [009](009-runtime-graph-types-contract.md) | `packages/runtime-graph/src/core/types.ts` est le contract entre 4 couches : (1) capture (OTel attach), (2)... | `packages/runtime-graph/src/core/types.ts` |
| [010](010-datalog-pure-deterministic.md) | Le package `@liby-tools/datalog` est un interpréteur Datalog pure-TS, ZÉRO binary externe (pas de Soufflé, ... | `packages/codegraph/src/facts/index.ts`, `packages/datalog/src/canonical.ts` +4 |
| [011](011-runtime-graph-capture-pipeline.md) | Le pipeline runtime capture est en 2 couches strictement séparées : (1) `otel-attach.ts` configure OTel SDK... | `packages/runtime-graph/src/capture/auto-bootstrap.ts`, `packages/runtime-graph/src/capture/otel-attach.ts` +7 |
| [012](012-extractor-shared-helpers.md) | Les helpers ts-morph utilisés par 2+ extractors vivent dans `packages/codegraph/src/extractors/_shared/`. P... | `packages/codegraph/src/extractors/_shared/ast-helpers.ts`, `packages/codegraph/src/extractors/_shared/sql-helpers.ts` +1 |
| [024](024-bsp-monoid-parallelism.md) | Tout détecteur per-file (cf. ADR-005) DOIT exposer un `extractFileBundle` pure et son orchestrateur passe p... | `packages/codegraph/src/parallel/bsp-scheduler.ts`, `packages/codegraph/src/parallel/monoid.ts` +2 |


## Comment ajouter un ADR

1. Copier `_TEMPLATE.md` → `NNN-titre-court.md`
2. Remplir `Rule`, `Why`, `How to apply`, `Tested by` (≤30 lignes total)
3. Poser un marqueur `// ADR-NNN` au top du fichier ancré
4. Lancer `npx @liby-tools/adr-toolkit regen` (ou laisser le pre-commit le faire)
5. Si la règle mérite un test invariant : créer dans `tests/unit/<X>-invariant.test.ts`

## Détection automatique des violations

Le boot brief (auto-généré par `@liby-tools/adr-toolkit brief` post-commit) liste
les ADRs actifs et les fichiers gouvernés. Lire en début de session.
