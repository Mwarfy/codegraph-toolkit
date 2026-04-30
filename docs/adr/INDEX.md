# ADR Index — règles qui mordent

> **À LIRE en début de session.** Chaque ligne = une règle architecturale active.
> Si tu touches un fichier listé dans "Anchored in", lis l'ADR correspondant.
> Format ADR : voir `_TEMPLATE.md`.

## Conventions

| ADR | Règle qui mord | Anchored in |
|---|---|---|
| [001](001-synopsis-builder-pure.md) | Synopsis builder = pure, zéro LLM | `packages/codegraph/src/synopsis/` |
| [002](002-config-driven-no-hardcoded-projects.md) | Config-driven, jamais de path projet hardcodé | `packages/codegraph/src/config/` |
| [003](003-detectors-generaliste-vs-project-specific.md) | Détecteurs généralistes vs project-specific | `packages/codegraph/src/detectors/` |
| [004](004-bootstrap-trois-roles-separes.md) | Bootstrap = 3 rôles (codegraph détecte / LLM rédige / humain valide) | `packages/adr-toolkit/src/bootstrap*` |
| [005](005-detector-pattern-bundle-per-file.md) | Détecteurs codegraph = bundle per-file + agrégat pure | `packages/codegraph/src/detectors/`, `packages/codegraph/src/incremental/` |
| [006](006-core-types-canonical-contract.md) | `core/types.ts` = canonical contract, modifications conservatrices uniquement | `packages/codegraph/src/core/types.ts` |

## Comment ajouter un ADR

1. Copier `_TEMPLATE.md` → `NNN-titre-court.md`
2. Remplir `Rule`, `Why`, `How to apply`, `Tested by` (≤30 lignes total)
3. Poser un marqueur `// ADR-NNN` au top du fichier ancré
4. Lancer `npx @liby-tools/adr-toolkit regen` (ou laisser le pre-commit le faire)
5. Si la règle mérite un test invariant : créer dans `tests/unit/<X>-invariant.test.ts`

## Détection automatique des violations

Le boot brief (auto-généré par `@liby-tools/adr-toolkit brief` post-commit) liste
les ADRs actifs et les fichiers gouvernés. Lire en début de session.
