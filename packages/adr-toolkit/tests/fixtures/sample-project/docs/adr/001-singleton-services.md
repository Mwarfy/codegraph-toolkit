---
asserts:
  - symbol: "services/state-service#StateService"
    exists: true
  - symbol: "services/state-service#getInstance"
    exists: true
---

# ADR-001: Singleton lifecycle pour les services state

**Date:** 2026-04-28
**Status:** Accepted

## Rule

> Les services qui maintiennent un état runtime sont des singletons accédés
> via `getInstance()`. Pas d'instanciation directe par les consommateurs.

## Why

Plusieurs instances créent des états divergents. Vu en mars 2026 sur le test
de StateService.

## How to apply

- Constructeur privé
- `static instance` + `static getInstance()`
- Test invariant : assert sur l'unicité

## Anchored in

- (à régénérer par adr-toolkit regen)

## Tested by

- `tests/unit/state-service-invariant.test.ts`
