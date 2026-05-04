# ADR-024: Parallélisme déterministe par algèbre monoïdale (BSP)

**Date:** 2026-05-04
**Status:** Accepted

## Rule

> Tout détecteur per-file (cf. ADR-005) DOIT exposer un `extractFileBundle`
> pure et son orchestrateur passe par `runPerFileExtractor` (readFile-based)
> ou `runPerSourceFileExtractor` (Project ts-morph) — pas de boucle séquentielle.

## Why

Aujourd'hui (2026-05-04), `analyze` warm prend ~9.6s sur le toolkit
(175 fichiers). Le profil montre que les détecteurs per-file dominent
(ts-imports 1052ms, complexity, magic-numbers, etc. — chacun 50-200ms).

Plutôt que paralléliser le runtime Salsa (risqué : races, heisenbugs),
on redesigne au niveau architectural via algèbre monoïdale (Valiant
1990 BSP + Shapiro 2011 CRDT) : si chaque worker calcule une fn pure
et le résultat est combiné via un monoïde commutatif, l'ordre
d'évaluation n'affecte pas l'output. Théorème (Church-Rosser) →
output bit-identique entre runs, déterminisme garanti.

## How to apply

- Détecteur per-file readFile-based (todos, regex, secrets text-only) :
  ```ts
  const r = await runPerFileExtractor({
    files, readFile, extractor, selectItems, sortKey,
  })
  return r.items
  ```
- Détecteur Project ts-morph (magic-numbers, hardcoded-secrets, complexity) :
  ```ts
  const r = await runPerSourceFileExtractor({
    project, files, rootDir, extractor, selectItems, sortKey,
  })
  return r.items
  ```
- Le `extractor` DOIT être pure (read-only sur file content / sf). Aucune
  mutation d'état partagé. Aucun side-effect (fs.writeFile, console.log, etc.).
- Le `sortKey` DOIT être canonique — typiquement `${file}:${line.padStart(8, '0')}`
  pour ordre stable lex.
- Pour les détecteurs cross-file (cycles, articulation points, NCD,
  PageRank) : reste séquentiel — c'est la Phase 3 du BSP, par design.
  Pas de port vers monoïde possible.

## Anchored in

<!-- AUTO-GÉNÉRÉ depuis les marqueurs ADR-NNN du code source. Voir @liby-tools/adr-toolkit. NE PAS éditer à la main. -->

- `packages/codegraph/src/extractors/todos.worker.ts`
- `packages/codegraph/src/parallel/bsp-scheduler.ts`
- `packages/codegraph/src/parallel/monoid.ts`
- `packages/codegraph/src/parallel/per-file-extractor.ts`
- `packages/codegraph/src/parallel/per-source-file-extractor.ts`
- `packages/codegraph/src/parallel/worker-pool.ts`


## Tested by

- `packages/codegraph/tests/parallel-determinism.test.ts` (8 tests : 100 runs
  bit-identiques, speedup ≥ 2 mesuré)

## Detail

**Théorème (Church-Rosser confluence)** : un système de réécriture est
confluent ⟺ il a la propriété diamond. Pour un détecteur :

```
extract(file_a) ⊕ extract(file_b) = extract(file_b) ⊕ extract(file_a)  ; commutatif
(a ⊕ b) ⊕ c = a ⊕ (b ⊕ c)                                              ; associatif
```

Sur les monoïdes commutatifs (sum/max/union/map), parallel ≡ sequential
sans coordination. Sur les non-commutatifs (appendList), `sortFn` post-merge
restaure l'ordre canonique → bit-identique entre runs.

**Phase actuelle (α)** : `parallelMap` utilise Promise.all dans le main
thread. Gain limité sur CPU-bound (Node single-thread JS). Vrai gain sur
I/O-bound (reads + writes parallel).

**Phase β prévue** : worker_threads. L'API `parallelMap` ne change pas — le
scheduler dispatche sur N workers. Gain attendu × N cores sur projets
> 100 fichiers.

**Pourquoi pas full Salsa parallelism (mutable shared state)** :
- Race conditions possibles → heisenbugs
- Non-déterminisme → casse les invariants test (snapshot-deterministic)
- Memory 8× (réplica state)
- BSP+monoïde garantit déterminisme PAR ALGÈBRE — pas de coordination nécessaire.
