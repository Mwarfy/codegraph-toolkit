---
asserts:
  - symbol: "core/detector-registry#createDetectors"
    exists: true
  - symbol: "core/detector-registry#defaultDetectorNames"
    exists: true
---

# ADR-008: detector-registry est le SEUL point d'enregistrement de détecteurs

**Date:** 2026-05-03
**Status:** Accepted

## Rule

> Tout nouveau détecteur (`extends BaseDetector`) DOIT être enregistré dans
> `core/detector-registry.ts` via `createDetectors()`. Pas de détecteur
> instancié ailleurs (analyzer.ts ne fait QUE consommer le registry). La
> propriété `projectSpecific: true` exclut le détecteur de la liste par
> défaut — opt-in explicite via config.

## Why

18+ extracteurs/détecteurs partagent le même contract `BaseDetector`. Sans
registry central, l'ordering, l'opt-in/opt-out projet-spécifique, et la
découverte par `defaultDetectorNames()` deviennent du code spaghetti
réparti dans analyzer.ts. Le registry permet un pattern uniforme :
- analyzer.ts itère sur `createDetectors(enabledNames)` sans connaître
  les détecteurs individuels.
- Les consumers (Sentinel, Morovar) personnalisent via la config sans
  patch du toolkit.
- Tests : on peut tester un détecteur isolé en l'instanciant via le
  registry avec son nom seul.

## How to apply

Pour ajouter un détecteur :
- Implémenter `class MyDetector extends BaseDetector { readonly name = 'my-detector' }`.
- L'ajouter à la liste dans `createDetectors()` du registry.
- Si project-specific (Sentinel-only patterns), marquer `projectSpecific: true`.

Ne plus faire :
- Instancier directement `new MyDetector()` dans `analyzer.ts`.
- Brancher un détecteur via une condition `if (rootDir.includes('sentinel'))`.

Pour tester un détecteur isolé : `createDetectors(['my-detector'])`.

## Anchored in

<!-- AUTO-GÉNÉRÉ depuis les marqueurs ADR-NNN du code source. Voir @liby-tools/adr-toolkit. NE PAS éditer à la main. -->

- `packages/codegraph-mcp/src/snapshot-loader.ts`
- `packages/codegraph/src/core/analyzer.ts`
- `packages/codegraph/src/core/detector-registry.ts`
- `packages/codegraph/src/core/detectors/barrels-detector.ts`
- `packages/codegraph/src/core/detectors/complexity-detector.ts`
- `packages/codegraph/src/core/detectors/cross-discipline-detector.ts`
- `packages/codegraph/src/core/detectors/cycles-detector.ts`
- `packages/codegraph/src/core/detectors/data-flows-detector.ts`
- `packages/codegraph/src/core/detectors/drizzle-schema-detector.ts`
- `packages/codegraph/src/core/detectors/env-usage-detector.ts`
- `packages/codegraph/src/core/detectors/event-emit-sites-detector.ts`
- `packages/codegraph/src/core/detectors/oauth-scope-literals-detector.ts`
- `packages/codegraph/src/core/detectors/package-deps-detector.ts`
- `packages/codegraph/src/core/detectors/sql-schema-detector.ts`
- `packages/codegraph/src/core/detectors/state-machines-detector.ts`
- `packages/codegraph/src/core/detectors/symbol-refs-detector.ts`
- `packages/codegraph/src/core/detectors/taint-detector.ts`
- `packages/codegraph/src/core/detectors/truth-points-detector.ts`
- `packages/codegraph/src/core/detectors/typed-calls-detector.ts`
- `packages/codegraph/src/core/detectors/unused-exports-detector.ts`
- `packages/codegraph/src/core/file-discovery.ts`
- `packages/codegraph/src/core/graph.ts`
- `packages/codegraph/src/detectors/ts-imports.ts`
- `packages/codegraph/src/map/dsm-renderer.ts`


## Tested by

- `packages/codegraph/tests/detector-registry.test.ts` — vérifie que tous
  les détecteurs sont enregistrés et que le filter `projectSpecific`
  fonctionne.
