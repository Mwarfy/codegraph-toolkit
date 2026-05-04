# ADR-026: Détecteurs comme rules Datalog sur facts AST denormalisés

**Date:** 2026-05-04
**Status:** Accepted (prototype validé sur 2 détecteurs ; port progressif)

## Rule

> Tout nouveau détecteur per-file CPU-bound DOIT s'écrire comme :
> 1. Émission de tuples primitifs depuis `ast-facts-visitor.ts` (visite AST
>    UNIQUE, partagée cross-detector) ;
> 2. Une ou plusieurs rules `.dl` qui dérivent l'output métier depuis ces
>    primitives + lookup tables.
>
> Les détecteurs existants (Phase 2 BSP monoïdal) restent fonctionnels et
> servent de référence BIT-IDENTICAL pour les ports.

## Why

Phase γ.2/γ.3 a montré empiriquement que **paralléliser les détecteurs
ts-morph en workers ne gagne pas wall-clock** : le coût ts-morph init ×
N workers + IPC traffic dépasse le gain × N cores pour les tailles de
codebase visées (~200-700 fichiers). Le vrai bottleneck était **la
duplication du parse AST entre détecteurs** — chaque `analyzeXxx()`
re-traverse le même AST pour ses propres patterns.

Réécrire les détecteurs comme rules Datalog sur facts denormalisés
attaque ce bottleneck à la source :

- **1 visite AST partagée** émet tous les tuples nécessaires aux
  détecteurs en parallèle (single-pass visitor pattern).
- **Datalog évalue les rules** en mode semi-naïve avec indexes — beaucoup
  plus rapide qu'une chaîne de `forEachDescendant` per-detector.
- **Caching incrémental** trivial sur les facts (Salsa-iso natif).
- **Querying interactif** : `codegraph datalog-query` peut lancer une rule
  ad-hoc sans recompiler.
- **Composabilité** : nouvelle règle = nouveau `.dl`, pas de code TS.
- **Self-describing** : les invariants ADR (cf. ADR-022) vivent déjà
  comme rules `.dl`. Cohérence architecturale.

Bench prototype (magic-numbers + dead-code/identical-subexpr) :
- Toolkit (183 fichiers) : 557ms legacy → 287ms Datalog (1.93×)
- Sentinel (220 fichiers) : 705ms legacy → 468ms Datalog (1.51×)
- 11/11 outputs BIT-IDENTICAL

## How to apply

### 1. Étendre le visitor

Ajouter dans `packages/codegraph/src/datalog-detectors/ast-facts-visitor.ts`
les primitives nécessaires pour le détecteur :

```ts
export interface MyNewFact {
  file: string
  line: number
  // ... colonnes plates, JSON-cloneable
}
```

Le visitor visite l'AST UNE fois ; chaque détecteur lit ses primitives.

### 2. Écrire la rule

Dans `packages/codegraph/src/datalog-detectors/rules/index.ts`, ajouter
le bloc `.dl` :

```datalog
MyOutput(F, L, ...) :-
  MyPrimitive(F, L, X, Y, ...),
  MyLookup(X),
  !FileTag(F, "test"),
  !ExemptionLine(F, L, "my-marker-ok").
```

Convention :
- Variables capitalisées (`F`, `L`, `Sym`).
- Booleans 0/1 piné dans atom args (le parser engine n'accepte pas `=`
  comme constraint operator — seulement `!=`, `>`, `<`, `>=`, `<=`).
- Number columns sont entiers — float values truncés via
  `Math.trunc(Math.abs(value))`.
- TSV-unsafe chars (`\t`, `\n`, `\r`) sanitized en visitor via `safe()`.

### 3. Wire dans le runner

`packages/codegraph/src/datalog-detectors/runner.ts` : ajouter le projet
de l'output relation aux types métier dans `DatalogDetectorResults`.

### 4. Vérifier BIT-IDENTICAL

`packages/codegraph/scripts/bench-datalog-detectors.mjs <projectRoot>` :
runs legacy + Datalog, diff les outputs, doit être `BIT-IDENTICAL`.

### 5. Wire dans `analyzer.ts` (futur)

Une fois tous les détecteurs ts-morph portés, `analyzer.ts` peut court-
circuiter via env var `LIBY_DATALOG_DETECTORS=1`. Pas urgent — le legacy
reste correct.

## Anchored in

<!-- AUTO-GÉNÉRÉ depuis les marqueurs ADR-NNN du code source. Voir @liby-tools/adr-toolkit. NE PAS éditer à la main. -->


## Tested by

- `packages/codegraph/tests/datalog-detectors.test.ts` (verify
  BIT-IDENTICAL sur fixtures + sur le toolkit lui-même)

## Detail

**Trade-offs**

- **Coût de port** : ~30min-2h par détecteur selon complexité (pre-compute
  features cheap → emit tuple → write rule). Plus rapide que ré-écrire
  l'extractor en pur TS si le pattern est exprimable en Datalog standard.
- **Limites du moteur** : `=` non supporté comme constraint, pas de string
  ops, number columns = integers. Les détecteurs avec heuristique
  numérique complexe (entropy de Shannon, edit distance, etc.) doivent
  pré-calculer ces features dans le visitor et les passer comme colonnes.
- **Détecteurs cross-file** (cycles, articulation points, NCD) restent
  exclus du pattern (Phase 3 du BSP — par design). Le visitor est
  per-file ; les rules cross-file lisent les facts globaux.

**Pourquoi pas garder Phase γ.2 workers**

L'architecture worker reste correcte mais ne gagne pas pour les workloads
ts-morph CPU-bound courts ; cette ADR redirige les NOUVEAUX détecteurs
per-file vers Datalog par défaut. Les workers γ.2 restent disponibles
pour les détecteurs hors AST (regex sur huge files, hash, etc.).
