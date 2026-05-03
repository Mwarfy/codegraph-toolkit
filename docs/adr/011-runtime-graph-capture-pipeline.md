---
asserts:
  - symbol: "runtime-graph/capture/otel-attach#attachRuntimeCapture"
    exists: true
  - symbol: "runtime-graph/capture/span-aggregator#aggregateSpans"
    exists: true
---

# ADR-011: runtime-graph capture pipeline — OTel attach + span-to-fact projection

**Date:** 2026-05-03
**Status:** Accepted

## Rule

> Le pipeline runtime capture est en 2 couches strictement séparées :
> (1) `otel-attach.ts` configure OTel SDK + auto-instruments + collect
> les spans en mémoire ; (2) `span-aggregator.ts` projette les spans
> ReadableSpan vers les facts canoniques (HttpRouteHit, DbQueryExecuted,
> etc.). **Aucun mélange** : l'attach ne projette pas, l'aggregator ne
> touche pas l'OTel SDK. Un span sans attribute matchant est ignoré.

## Why

Pourquoi cette séparation rigide :

1. **Testabilité** : `aggregateSpans(spans, opts)` est PUR — input array
   de spans, output snapshot. Tests unitaires sans avoir à booter OTel.
2. **Capture critique** : `otel-attach.ts` doit `forceFlush + getFinishedSpans
   (copy) AVANT shutdown` — pattern réinventé en α.3 après bug : shutdown
   clear le InMemorySpanExporter buffer avant lecture, perdant tous les
   spans. Cas critique appris à la dur.
3. **Schemas alignés OTel** : l'aggregator parse `http.method`, `db.system`,
   `db.statement`, `code.filepath`, `code.function` — semconv standard.
   Permet d'ajouter ANY auto-instrumentation OTel sans patcher le toolkit.

## How to apply

Faire :
- Nouveau fact runtime → ajouter au schema `core/types.ts` (ADR-009)
  + ajouter projection dans `span-aggregator.ts` matchant l'OTel
  semconv attribute.
- Test = `aggregateSpans(syntheticReadableSpans, opts)` — pas besoin
  d'OTel SDK.
- forceFlush PUIS getFinishedSpans (copy) AVANT shutdown — toujours
  dans cet ordre.

Ne plus faire :
- Mixer projection dans `attachRuntimeCapture` (cassérait la pureté de
  l'aggregator).
- Skip le forceFlush avant shutdown (perd les spans en buffer).
- Inventer un attribute custom propriétaire au lieu d'utiliser semconv.

## Anchored in

<!-- AUTO-GÉNÉRÉ depuis les marqueurs ADR-NNN du code source. Voir @liby-tools/adr-toolkit. NE PAS éditer à la main. -->

- `packages/runtime-graph/src/capture/auto-bootstrap.ts`
- `packages/runtime-graph/src/capture/otel-attach.ts`
- `packages/runtime-graph/src/capture/span-aggregator.ts`
- `packages/runtime-graph/src/drivers/_common.ts`
- `packages/runtime-graph/src/drivers/chaos.ts`
- `packages/runtime-graph/src/drivers/replay-tests.ts`
- `packages/runtime-graph/src/drivers/synthetic.ts`
- `packages/runtime-graph/src/facts/exporter.ts`
- `packages/runtime-graph/src/metrics/runtime-disciplines.ts`


## Tested by

- `packages/runtime-graph/tests/aggregator.test.ts` — pureté de la
  projection sur spans synthétiques.
- `packages/runtime-graph/tests/otel-smoke.test.ts` — capture E2E sur
  un mini-app instrumenté.
