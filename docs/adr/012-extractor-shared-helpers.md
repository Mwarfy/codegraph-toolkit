---
asserts:
  - symbol: "extractors/_shared/ast-helpers#getCallExpressionsByName"
    exists: true
---

# ADR-012: Extractors `_shared/` — helpers ts-morph mutualisés

**Date:** 2026-05-03
**Status:** Accepted

## Rule

> Les helpers ts-morph utilisés par 2+ extractors vivent dans
> `packages/codegraph/src/extractors/_shared/`. Pas de duplication
> ad-hoc dans les extractors individuels. Les fonctions `_shared/`
> sont **pures** (SourceFile in, donnée out — pas d'I/O, pas d'état).

## Why

`ast-helpers.ts` est importé par 14 extractors. Avant cet ADR, chaque
extractor inventait ses propres helpers (`getCallExpressionsNamed`,
`extractStringLiteralArg`, `findClassByName`) — patterns dupliqués qui
divergeaient subtilement (une version null-safe, une autre throw, une
autre logue). NCD detection a flaggé ces duplications en avril 2026.

La consolidation dans `_shared/` :
- 1 source de vérité pour les patterns AST courants.
- Test unique du helper, pas N tests pour N copies.
- Rules `salsa` peuvent cacher les helpers (1 cache vs N).
- Refactor ts-morph ↔ alternative (futur swc-walker) en 1 endroit.

## How to apply

Faire :
- Nouveau helper utilisé par ≥ 2 extractors → `_shared/` immédiatement.
- Pure function : `(sf: SourceFile, ...args) => result`.
- Documenter l'invariant ts-morph version (e.g. "fonctionne avec
  ts-morph 22+, getDescendantsOfKind").

Ne plus faire :
- Recopier un helper depuis un autre extractor (même 5 lignes).
- I/O ou état mutable dans un `_shared/` helper.
- `_shared/` qui dépend d'un extractor concret (anti-cycle).

## Anchored in

<!-- AUTO-GÉNÉRÉ depuis les marqueurs ADR-NNN du code source. Voir @liby-tools/adr-toolkit. NE PAS éditer à la main. -->

- `packages/codegraph/src/extractors/_shared/ast-helpers.ts`
- `packages/codegraph/src/extractors/_shared/sql-helpers.ts`
- `packages/codegraph/src/extractors/_shared/sql-types.ts`


## Tested by

- `packages/codegraph/tests/ast-helpers.test.ts` — couvre chaque helper
  isolément.
- Tests E2E des 14 extractors qui consomment `_shared/` valident
  indirectement.
