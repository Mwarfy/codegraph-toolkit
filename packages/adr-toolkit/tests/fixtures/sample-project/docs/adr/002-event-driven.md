---
asserts:
  - symbol: "core/event-bus#emit"
    exists: true
---

# ADR-002: Communication par events

**Date:** 2026-04-28
**Status:** Accepted

## Rule

> Les modules communiquent via `event-bus.emit()`. Pas d'appel direct
> cross-module.

## Why

Découplage. Permet d'ajouter des listeners sans toucher aux émetteurs.

## How to apply

- Importer `emit` depuis `core/event-bus`
- Pas d'import direct entre modules feature

## Anchored in

- (à régénérer)
