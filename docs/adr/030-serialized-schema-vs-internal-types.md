# ADR-030: Schéma JSON sérialisé stable, types internes libres d'évolution

**Date:** 2026-05-11
**Status:** Accepted
**Supersedes:** ADR-006

## Rule

> Le seul contrat public du toolkit est le **schéma JSON sérialisé**
> (`snapshot.json`, `facts.head.json`, etc. — consommés par Sentinel,
> codegraph-mcp, hooks bash, consumers externes). Ce schéma est
> versionné via `SnapshotMeta.version` et reste backward-compatible
> par défaut.
>
> Le **code TypeScript interne** (`core/types.ts`, structure des
> modules, organisation des types) est libre d'évolution — y compris
> découpage en plusieurs fichiers, restructuration, renommage interne
> — TANT QUE le JSON sérialisé final reste stable (ou versionné via
> bump explicite).

## Why

ADR-006 (Apr 2026, supersédée par ce document) protégeait `core/types.ts`
comme top hub (88 imports) avec la règle "modifications conservatrices
uniquement". L'intention était bonne (le bug truth-points hook avait
montré qu'un changement silencieux de shape casse les consumers), mais
la solution **figeait la mauvaise frontière** :

- ADR-006 mélangeait deux choses distinctes :
  1. *Contrat externe* — `snapshot.json` consommé par Sentinel/MCP/hooks
  2. *Couplage interne* — `core/types.ts` importé par 88 fichiers du toolkit
- La règle "ne pas modifier" gelait les DEUX, alors que seul (1) est un
  vrai contrat avec l'extérieur.

Conséquence concrète identifiée au 2026-05-11 : le chantier découpage
`GraphSnapshot` en sub-snapshots (= fix du fat-blob anti-pattern, parse
mémoire tout-ou-rien) **est bloqué par ADR-006**. On ne peut pas
restructurer les types internes sans violer la règle "conservative".

Pour scaler le projet (snapshots > 5 MB, projets cibles > 3k files),
le découpage est nécessaire. La règle qui le bloque est elle-même la
dette à refondre.

## How to apply

### Contrat externe : JSON sérialisé (= ce qui ne change pas sans version bump)

- `snapshot.json` — schéma identifié par `meta.version` (v2 depuis
  ADR-027 Phase 2). Toute modification rétrocompatible (= ajout de
  champ optionnel) ne demande pas de bump. Toute modification
  incompatible (suppression, renaming, sémantique modifiée) demande
  un bump explicite + une stratégie de migration documentée.
- `facts.head.json`, `facts.store.ndjson`, `facts.bases/*.json` —
  versionnés via `FACT_STORE_VERSION` (ADR-027 Phase 3).
- Les autres fichiers `.codegraph/*` (synopsis.json, facts/*.facts)
  suivent leur propre versioning si non couvert par meta.

### Code interne : libre d'évolution

- **Découpage** : `core/types.ts` peut être splitté en
  `core/types/graph.ts` + `core/types/detectors/*.ts` etc. — tant
  que le JSON sérialisé final assemble une shape stable.
- **Renommage TypeScript** : un type `TruthPoint` peut devenir
  `TruthPointInternal` en interne, exposé en `TruthPoint` dans le
  JSON. Le mapping serialize/deserialize est explicite, pas une
  fuite de la structure interne.
- **Sub-snapshots** (= chantier débloqué par ce ADR) : passer d'un
  blob unique à plusieurs sous-fichiers indexés (`snapshot.json` +
  `snapshot.detectors/<name>.json`) reste un contrat externe à
  documenter, mais peut s'introduire en parallèle du format v2 (=
  v3 avec migration douce).

### Garde-fous nécessaires

- **Tests d'invariants schéma** : un test qui assertionne la shape
  publique de `snapshot.json` (= champs requis présents, types
  conformes). Pour qu'un changement interne qui casserait le JSON
  pète au CI, pas à la prod.
  - Existant : `tests/parity.test.ts` (vérifie cross-mode legacy
    vs Datalog).
  - À ajouter : `tests/snapshot-schema-invariant.test.ts` qui valide
    la shape sérialisée contre une définition explicite.
- **`SnapshotMeta.version`** : bump explicite obligatoire pour toute
  modification incompatible du JSON.
- **Migration douce** : v(N-1) doit rester lisible pendant N
  releases après introduction de v(N). Pattern déjà appliqué par
  ADR-027 Phase 2.

## Anti-patterns

- **Geler le code pour préserver un contrat externe** : confond les
  deux niveaux. La bonne réponse est un test d'invariant qui pète au
  CI si la shape sérialisée dévie.
- **Modifier le JSON sans bumper `meta.version`** : casse les consumers
  externes silencieusement (cf. bug truth-points hook qui a déclenché
  ADR-006).
- **Faire la migration externe et interne en même temps** : si on
  veut découper les types internes ET versionner le snapshot, faire
  les deux dans des PRs séparées pour réduire le blast radius.

## Anchored in

<!-- AUTO-GÉNÉRÉ depuis les marqueurs ADR-NNN du code source. Voir @liby-tools/adr-toolkit. NE PAS éditer à la main. -->

- `packages/codegraph/src/core/types.ts`


## Tested by

- À créer : `packages/codegraph/tests/snapshot-schema-invariant.test.ts`
  Validation explicite de la shape `snapshot.json` (= contrat externe).
  Doit péter si un champ documenté disparaît sans bump de `meta.version`.
- Existant : `packages/codegraph/tests/parity.test.ts` (cross-mode
  invariance) reste pertinent.

## Detail

### Différence concrète avec ADR-006

| | ADR-006 | ADR-030 |
|---|---|---|
| Niveau gelé | Fichier TS + JSON | JSON seulement |
| Modif interne (= split, refactor) | Interdite | OK |
| Modif JSON (= breaking) | Interdite | Bump version explicite |
| Garde-fou | Convention humaine | Test d'invariant CI |

### Pourquoi `core/types.ts` en top hub n'est PAS un problème en soi

`core/types.ts` à 88 imports indique simplement qu'il est l'agrégat des
contrats internes. C'est attendu pour un module qui définit les types
partagés. Le PROBLÈME identifié dans ADR-006 (drift silencieux entre
detector et consumer) se résout par un **test d'invariant schéma**, pas
par un gel du fichier.

### Migration depuis ADR-006

- ADR-006 reste lisible dans l'histoire git (jamais supprimée). Marquée
  `Superseded by ADR-030` dans son frontmatter au prochain pre-commit.
- Marqueurs `// ADR-006` dans le code (s'il y en a) sont remplacés par
  `// ADR-030` au prochain refacto.
- La règle de fond ("ne pas péter le contrat snapshot.json") reste
  identique — elle est juste déplacée du fichier vers le JSON.

### Pourquoi pas garder ADR-006 et juste ajouter une note ?

Considéré. Rejeté parce que :
- ADR-006 mélange deux niveaux dans sa formulation. Patcher avec une
  note rend la règle ambiguë.
- Un futur Claude qui lit ADR-006 lira "modifications conservatrices
  uniquement" et appliquera ça aux types internes — même si on note
  "voir aussi ADR-030".
- La supersession explicite est plus claire.

## References

- ADR-006 (supersédée) — formulation originale du gel
- ADR-027 Phase 2 — pattern de versioning JSON via `SnapshotMeta.version`
- ADR-029 — *signaux propres avant refonte* (la prémisse ici : ADR-006
  était un "signal" mélangeant 2 niveaux ; on butte avant d'agir)
