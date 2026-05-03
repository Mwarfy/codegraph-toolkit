# ADR-005: Pattern détecteurs codegraph — bundle per-file + agrégat pure

**Date:** 2026-04-30
**Status:** Accepted

## Rule

> Tout détecteur codegraph qui scanne des fichiers TS expose 4 éléments :
> 1. Un helper pure `extractXxxFileBundle(sf, relPath, rootDir, project?)`
>    qui dérive un bundle sérialisable d'UN seul SourceFile.
> 2. Si l'agrégation est non-triviale, un helper pure
>    `aggregateXxxBundles(bundlesByFile)` qui fusionne sans I/O ni AST.
> 3. Une fonction batch publique `analyzeXxx(rootDir, files, ...)` qui
>    compose les deux ci-dessus en boucle (chemin legacy préservé).
> 4. Un wrapper Salsa dans `incremental/xxx.ts` exposant
>    `xxxBundleOfFile(path)` (derived sur `fileContent`) +
>    `allXxx(label)` (derived qui agrège).
>
> Aucun détecteur ne mélange I/O async + AST walk + agrégation globale dans
> une même fonction batch monolithique.

## Why

Découvert pendant la migration Sprint 11.2 (unused-exports). Le détecteur
legacy faisait 4 passes globales (import map, test scan, dynamic usage,
classify) intriquées dans une seule fonction async de 670 lignes. Le
refactoring vers Salsa a coûté 4h+ parce qu'il fallait d'abord extraire
un helper per-file qui n'existait pas, sans casser la parité bit-pour-bit.

Les 13 autres détecteurs (Sprint 3) qui suivaient déjà ce pattern dès la
phase batch ont été migrés en <30min chacun, parité instantanée. La
différence de coût est ~10x pour la même fonctionnalité.

L'enjeu réel n'est pas la perf. C'est que **chaque détecteur écrit sans
ce pattern devra être refactoré le jour où on voudra le cacher**, et le
refactor est risqué (parité bit-pour-bit difficile à garantir
post-coup). Forcer le pattern dès la naissance évite la dette.

## How to apply

- **Quand on écrit un nouveau détecteur** : commence par
  `extractXxxFileBundle(sf, relPath, rootDir, project?)` qui retourne un
  type sérialisable JSON (Record/array/primitives, pas Map/Set ni
  références ts-morph). Si certaines info dérivent d'UN seul fichier
  (ex: `isUsedLocally`), pré-calcule-les dans le bundle plutôt qu'en
  agrégation — mieux pour le cache.
- **L'agrégation ne fait pas d'I/O** : `analyzeXxx` lit les fichiers,
  loop sur extract, puis appelle un agrégat pure. Le wrapper Salsa
  réutilise le même agrégat pure tel quel.
- **Si une dépendance externe est nécessaire** (test files, package
  manifests, SQL defaults) : passer en `input<K, V>` Salsa séparé,
  set par l'orchestrateur via `setInputIfChanged`. Le bundle per-file
  ne lit JAMAIS de fichier autre que le sien.
- **Inputs riches doivent être JSON-stable** : pas de `Map`/`Set` —
  utiliser `Record<string, T[]>` trié pour que `JSON.stringify` donne
  une signature reproductible (sinon `setInputIfChanged` casse
  silencieusement).
- **ANTI-PATTERN** : helper qui prend `rootDir + files[]` et fait tout
  d'un coup. Invariant : on doit pouvoir appeler le helper sur 1 seul
  fichier sans connaître les autres.
- **ANTI-PATTERN** : returner des références ts-morph dans le bundle.
  Le bundle doit survivre à un Project recréé — donc valeurs primitives
  ou structures de données pures uniquement.

## Anchored in

<!-- AUTO-GÉNÉRÉ depuis les marqueurs ADR-NNN du code source. Voir @liby-tools/adr-toolkit. NE PAS éditer à la main. -->

- `packages/codegraph/src/cli/_shared.ts`
- `packages/codegraph/src/cli/commands/analyze.ts`
- `packages/codegraph/src/cli/commands/datalog-check.ts`
- `packages/codegraph/src/cli/commands/diff.ts`
- `packages/codegraph/src/extractors/_internal/code-quality/_helpers.ts`
- `packages/codegraph/src/extractors/co-change.ts`
- `packages/codegraph/src/extractors/compression-similarity.ts`
- `packages/codegraph/src/extractors/constant-expressions.ts`
- `packages/codegraph/src/extractors/eslint-import.ts`
- `packages/codegraph/src/extractors/package-deps.ts`
- `packages/codegraph/src/extractors/sql-schema.ts`
- `packages/codegraph/src/extractors/state-machines.ts`
- `packages/codegraph/src/extractors/unused-exports.ts`


## Tested by

- `packages/codegraph/tests/incremental.test.ts` — vérifie cache hit + parité legacy/incremental
- `packages/codegraph/tests/parity.test.ts` (à venir) — fixture représentative, snapshot legacy === --incremental

## Detail

### Pourquoi sérialisable JSON natif (pas Map/Set)

`setInputIfChanged` (`incremental/queries.ts`) compare deux valeurs via
`JSON.stringify`. Une `Map` stringifie en `'{}'`, donc deux Maps
différentes paraissent identiques → cache pollué silencieusement, pas
d'invalidation, bugs subtils sans erreur.

Le piège a été rencontré sur `TestFilesIndex` en Sprint 11.2. Solution :
`Record<string, string[]>` avec clés et valeurs triées, signature
JSON.stringify reproductible et stable cross-runs.

### Pourquoi pré-calculer `isUsedLocally` dans le bundle

`isUsedLocally(fileText, name, line)` ne dépend QUE du fichier courant.
Si on le calcule au moment de la classification (agrégat global), on
re-fait le travail à chaque agrégat — même si le fichier n'a pas changé.
En le calculant DANS le bundle per-file, le résultat est cached avec le
bundle, et l'agrégat le lit directement.

C'est un cas particulier du principe : **toute info dérivable d'un seul
fichier vit dans le bundle de ce fichier**. L'agrégat ne fait que de la
fusion / classification, pas d'extraction.

### Migration des détecteurs legacy

Si un détecteur existant ne suit pas le pattern, le refactor est :
1. Extraire `extractXxxFileBundle(sf, file, rootDir, project)` en
   préservant la sortie globale.
2. Refactor `analyzeXxx()` pour boucler sur l'extract + agréger pur.
3. Tests parité avant/après (snapshot diff sur fixture représentatif).
4. Wrapper Salsa par-dessus dans un commit séparé.

Coût observé : ~30min pour un détecteur simple (≤200 lignes, peu de
passes globales), ~3-4h pour un détecteur complexe (≥600 lignes, 3-4
passes globales intriquées).
