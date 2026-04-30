---
asserts:
  - symbol: "synopsis/builder#buildSynopsis"
    exists: true
  - symbol: "core/types#GraphSnapshot"
    exists: true
---

# ADR-001: Synopsis builder = pur, zéro LLM

**Date:** 2026-04-29
**Status:** Proposed

## Rule

> Le synopsis builder (`@liby-tools/codegraph buildSynopsis`) ne fait aucun I/O,
> n'invoque aucun LLM, n'utilise aucune source non-déterministe. Même
> snapshot d'entrée → même output JSON byte-équivalent.

## Why

Sans cette propriété, la mental map devient irreproductible : 2 lectures
du même brief peuvent surfacer des informations différentes, l'agent IA
n'a plus de sol fiable. Test `synopsis-determinism` (10× build = même
JSON byte-pour-byte) verrouille l'invariant. C'est le cœur de la
"convention zéro LLM" du README — si on la viole, tout le reste perd
sa garantie de reproductibilité.

## How to apply

- Le builder reçoit `(snapshot, options)` et retourne `SynopsisJSON`
  uniquement. Pas de `readFile`, pas d'API externe, pas de `Date.now()`.
- Si une info externe est requise (ex: marqueurs ADR du code), l'appelant
  la pré-calcule et la passe via `options`.
- Tout tri d'array doit utiliser un comparateur stable et déterministe.
- ANTI-PATTERN : appeler `git`, lire un fichier, faire un fetch, utiliser
  `Math.random()`, ou itérer `for..in` sur un objet (ordre non-garanti).

## Anchored in

<!-- AUTO-GÉNÉRÉ depuis les marqueurs ADR-NNN du code source. Voir @liby-tools/adr-toolkit. NE PAS éditer à la main. -->

- `packages/codegraph/src/synopsis/builder.ts` — synopsis builder pur, zéro LLM, déterministe
- `packages/codegraph/src/synopsis/tensions.ts` — synopsis builder pur, zéro LLM, déterministe — tensions inclus


## Tested by

- `packages/codegraph/tests/synopsis-determinism.test.ts` — 10 invocations sur même input doivent produire le même JSON byte-équivalent.
