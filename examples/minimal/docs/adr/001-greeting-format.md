# ADR-001: Format de salutation

**Date:** 2026-04-28
**Status:** Accepted

## Rule

> Toute salutation passe par `formatGreeting()` — pas de string concat ad-hoc.

## Why

Si chaque module concatène à sa façon, on perd la cohérence (espacement,
ponctuation, casse). Centraliser permet aussi de localiser plus tard.

## How to apply

- Importer `formatGreeting` depuis `src/greeting`
- Pas de `"Hello " + name` direct dans les modules

## Anchored in

<!-- AUTO-GÉNÉRÉ depuis les marqueurs ADR-NNN du code source. Voir @liby/adr-toolkit. NE PAS éditer à la main. -->

- `src/greeting.ts` — format canonique des salutations


## Tested by

- _(pas encore)_
