# ADR Index — règles qui mordent

> **À LIRE en début de session.** Chaque ligne = une règle architecturale active.
> Si tu touches un fichier listé dans "Anchored in", lis l'ADR correspondant.
> Format ADR : voir `_TEMPLATE.md`.

## Conventions

| ADR | Règle qui mord | Anchored in |
|---|---|---|
| _(aucun ADR encore — créer le premier via `_TEMPLATE.md`)_ | | |

## Comment ajouter un ADR

1. Copier `_TEMPLATE.md` → `NNN-titre-court.md`
2. Remplir `Rule`, `Why`, `How to apply`, `Tested by` (≤30 lignes total)
3. Poser un marqueur `// ADR-NNN` au top du fichier ancré
4. Lancer `npx @liby/adr-toolkit regen` (ou laisser le pre-commit le faire)
5. Si la règle mérite un test invariant : créer dans `tests/unit/<X>-invariant.test.ts`

## Détection automatique des violations

Le boot brief (auto-généré par `@liby/adr-toolkit brief` post-commit) liste
les ADRs actifs et les fichiers gouvernés. Lire en début de session.
