# Note : ADRs 013-023 manquantes dans `docs/adr/`

**Date:** 2026-05-11
**Status:** Documentation centralisée — ne pas créer d'ADRs vides ici.

## Pourquoi ce document

L'INDEX des ADRs de `codegraph-toolkit` saute des numéros : on a
ADR-001..012, puis ADR-024..033. Les **ADRs 013-023 n'existent pas
dans ce repo**.

Si tu lis une doc `docs/PHASE-*-*.md`, `docs/DOGFOODING-*.md`, ou
`docs/ENRICHMENT-*-PLAN.md`, tu vas tomber sur des références à
`ADR-014`, `ADR-017`, `ADR-019`, `ADR-022`, etc. Ces références
ne pointent vers rien dans ce repo — c'est volontaire.

## Origine du gap

Ces ADRs vivaient (ou vivent encore) dans **Sentinel**, un projet
consommateur de `codegraph-toolkit` qui partage une partie de
l'histoire architecturale. Lors de l'extraction de codegraph-toolkit
en projet séparé, les ADRs Sentinel-specifiques n'ont pas été
migrées :

- **ADR-013** — magic numbers / thresholds (Sentinel)
- **ADR-014** — OAuth scopes migrés vers Datalog (Sentinel)
- **ADR-015** — resource thresholds (Sentinel)
- **ADR-016** — (?)
- **ADR-017** — event types (Sentinel)
- **ADR-018** — composite resolution (Sentinel)
- **ADR-019** — thresholds via Datalog ratchet (Sentinel)
- **ADR-020** — (?)
- **ADR-021** — articulation points + supervision (Sentinel)
- **ADR-022** — pattern Datalog + ratchet (Sentinel — formalisé)
- **ADR-023** — extension de ADR-022 (Sentinel — proposé)

Les concepts généralisables ont été repris ici :
- Pattern Datalog déclaratif → **ADR-026** (Détecteurs comme rules Datalog)
- Ratchet pattern + grandfathering → décrit dans
  `core/articulation-baseline.ts` + commentaires détecteurs
- Lifecycle snapshot / facts → **ADR-027** (vues dérivées) + **ADR-028**
  (compaction)

## Que faire si tu lis une ref vers ADR-NNN ∈ {013..023}

1. **Le document est un plan/rétrospective ancien** (e.g.
   `PHASE-1-SALSA-MIGRATION.md`, `PHASE-4-AGENT-FIRST-PLAN.md`,
   `PHASE-5-COMPOSITE-BACKLOG.md`) : ces docs gardent l'historique
   du sprint où le pattern a été développé conjointement avec
   Sentinel. Les refs sont **conservées telles quelles** pour ne
   pas perdre la traçabilité. Le concept équivalent dans le repo
   actuel est probablement dans ADR-026/027/028.

2. **Tu cherches le contenu réel** : consulter le repo Sentinel
   (privé) ou demander à Marius. La copie dans codegraph-toolkit
   n'existe pas et **ne sera pas créée** — recréer des ADRs vides
   ferait du bruit et de la fausse traçabilité.

3. **Tu veux poser un nouveau ADR sur un de ces concepts** : utiliser
   le prochain numéro libre (= 034 au moment de cette note), et
   référencer ADR-026/027/028 si pertinent. Ne pas réutiliser
   013-023.

## Anti-pattern : créer des ADR placeholders vides

Considéré et rejeté. Créer `docs/adr/013-magic-numbers-placeholder.md`
avec juste un titre :

- Pollue l'INDEX
- Donne une fausse impression d'existence du concept
- Empêche de distinguer "ADR jamais migrée" de "ADR active mais courte"

Ce document central suffit pour traçabilité.

## References

- `docs/PHASE-1-SALSA-MIGRATION.md` — refs ADR-014, 017, 019, 022
- `docs/PHASE-4-AGENT-FIRST-PLAN.md` — refs ADR-017, 018, 019
- `docs/PHASE-5-COMPOSITE-BACKLOG.md` — refs ADR-013, 015, 019, 021
- `docs/ENRICHMENT-5-AXES-PLAN.md` — refs ADR-022, 023
- `docs/DOGFOODING-DPL-RAG.md` — refs ADR-019
