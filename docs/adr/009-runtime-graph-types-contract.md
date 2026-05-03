---
asserts:
  - symbol: "runtime-graph/core/types#RuntimeSnapshot"
    exists: true
  - symbol: "runtime-graph/core/types#LatencySeriesFact"
    exists: true
---

# ADR-009: runtime-graph/core/types.ts = contrat canonique runtime

**Date:** 2026-05-03
**Status:** Accepted

## Rule

> `packages/runtime-graph/src/core/types.ts` est le contract entre 4
> couches : (1) capture (OTel attach), (2) aggregator (spans → facts),
> (3) exporter (facts → TSV/datalog), (4) datalog rules. Modifications
> conservatrices uniquement — ajout de champs optionnels OK, suppression
> ou changement de sémantique = breaking. Aligned with ADR-006 pour
> `codegraph/core/types.ts`.

## Why

Mêmes raisons qu'ADR-006 : le fichier est le SSOT pour le format des
facts runtime. 7 facts canoniques + 1 série time-series + 1 meta =
9 interfaces qui définissent le format des `.facts` TSV. Si on casse
le contract, le datalog rules s'écroulent en cascade — le runner ne
peut plus parser les arities. Les consumers externes (Sentinel,
projects OSS) sérialisent ces types vers disque puis les rejouent
plus tard — cassée la sémantique = invalider tout snapshot stocké.

## How to apply

Faire :
- Ajouter un nouveau champ optionnel : `newField?: T` — backward-compat.
- Renommer en deprecation : conserver l'ancien champ + flag JSDoc.
- Changer un Default (ex: `bucketSizeMs` 1000 → 500) sans toucher au type.

Ne plus faire :
- Renommer un champ existant directement (cassérait les `.facts` TSV column orders).
- Changer le type d'un champ (`number` → `string`) sans deprecation.
- Supprimer un champ — déprécier d'abord, supprimer après 2 minor versions.

## Anchored in

<!-- AUTO-GÉNÉRÉ depuis les marqueurs ADR-NNN du code source. Voir @liby-tools/adr-toolkit. NE PAS éditer à la main. -->

- `packages/runtime-graph/src/core/types.ts`


## Tested by

- `packages/runtime-graph/tests/exporter.test.ts` — vérifie le schema TSV
  reste byte-stable face aux modifications.
- `packages/runtime-graph/tests/aggregator.test.ts` — vérifie que les
  spans → facts conservent les sémantiques des champs.
