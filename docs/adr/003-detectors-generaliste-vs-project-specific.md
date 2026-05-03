---
asserts:
  - symbol: "detectors/index#createDetectors"
    exists: true
  - symbol: "detectors/index#defaultDetectorNames"
    exists: true
  - symbol: "detectors/index#listDetectorNames"
    exists: true
---

# ADR-003: Détecteurs généralistes par défaut, project-specific opt-in

**Date:** 2026-04-29
**Status:** Accepted

## Rule

> Le default detector set (`createDetectors([])` ou `defaultDetectorNames()`)
> exclut tous les détecteurs marqués `projectSpecific: true`. Pour les
> activer, le consommateur doit les nommer explicitement dans
> `codegraph.config.json` → `"detectors": [...]`.

## Why

`block-loader` cherche le pattern `BLOCK_CONSTRUCTORS: Record<string,
...>` qui est une convention Sentinel-only. Sans cette séparation,
n'importe quel projet qui utilise un objet nommé `XXX_CONSTRUCTORS`
voit ses imports faussement classés comme `dynamic-load` edges. Pire,
ça pollue les snapshots avec du bruit qui ne représente rien.

Le toolkit doit pouvoir grandir avec d'autres détecteurs project-
specific (ex: si Morovar développe un pattern de spawning de monsters
qu'il veut tracer) sans qu'ils contaminent les autres consommateurs.
La discipline `projectSpecific: true` rend le coût marginal d'un
nouveau détecteur très spécifique nul pour les autres.

## How to apply

- Ajouter un détecteur dans `ALL_DETECTORS` avec :
  ```ts
  'mon-detector': { factory: () => new MonDetector(), projectSpecific: true }
  ```
- Documenter en tête du fichier détecteur "PROJECT-SPECIFIC (NomDuProjet)"
  + comment l'activer (`detectors: ["...", "mon-detector"]` dans la config).
- Dans le détecteur lui-même, accepter le silence : si le pattern ne
  match nulle part, retourner `[]` sans warning. Pas d'erreur tonitruante
  — c'est juste que le projet ne suit pas cette convention.

## Anchored in

<!-- AUTO-GÉNÉRÉ depuis les marqueurs ADR-NNN du code source. Voir @liby-tools/adr-toolkit. NE PAS éditer à la main. -->

- `packages/codegraph/src/detectors/block-loader.ts` — project-specific (opt-in)
- `packages/codegraph/src/detectors/index.ts` — détecteurs généralistes par défaut, project-specific opt-in


## Tested by

- _(à ajouter : un test invariant qui vérifie que `defaultDetectorNames()`
  ne contient pas `block-loader` ni aucun futur détecteur
  `projectSpecific: true`.)_
