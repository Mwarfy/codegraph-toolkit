---
asserts:
  - symbol: "datalog/parser#parse"
    exists: true
  - symbol: "datalog/runner#runFromString"
    exists: true
  - symbol: "datalog/canonical#canonicalize"
    exists: true
---

# ADR-010: Datalog runtime — pure-TS, deterministic, zero binary

**Date:** 2026-05-03
**Status:** Accepted

## Rule

> Le package `@liby-tools/datalog` est un interpréteur Datalog pure-TS,
> ZÉRO binary externe (pas de Soufflé, pas de native node modules).
> Le runtime DOIT être déterministe : même program + same facts =
> même output, byte-pour-byte. La canonicalisation des relations passe
> par `canonical.ts` (sort lex). Le parser `parser.ts` ne fait aucun I/O.

## Why

Trois propriétés non-négociables :

1. **Pure-TS** : le toolkit est utilisé en pre-commit hooks et CI. Une
   binary native (souffle, llvm) casserait l'install npm sur Windows /
   ARM / containers minimalistes. La règle `pure-TS` garantit qu'`npm
   install` suffit, jamais besoin de `apt-get install souffle`.

2. **Déterministe** : le datalog gate les invariants ADR. Si un même
   program produit des outputs différents entre 2 runs, on aurait un
   "test flaky" au pre-commit — destructeur de confiance. Le sort lex
   sur les relations + iteration order stable de Map garantissent
   l'équivalence byte-à-byte.

3. **Zero I/O en parser** : `parse(source: string)` n'appelle JAMAIS
   `fs.readFile` ni un fetch. Tout I/O est dans `runner.ts` /
   `facts-loader.ts` qui orchestrent. Permet de tester le parser
   isolément (zero mock fs) et de l'appeler depuis web (browser) si
   besoin futur.

## How to apply

Faire :
- Tout nouveau builtin (custom predicate) implémenté en pur-TS dans
  `runner.ts`.
- Sort lex via `canonicalize()` à la fin de chaque rule evaluation.
- Tests via `runFromString(program, factsString)` — pas de filesystem.

Ne plus faire :
- `import` d'un module native (`.node`).
- Lecture fichier inline dans le parser ou les tests parser.
- Iteration sur `Map.entries()` sans tri ultérieur quand l'ordre fait
  partie de l'output.

## Anchored in

<!-- AUTO-GÉNÉRÉ depuis les marqueurs ADR-NNN du code source. Voir @liby-tools/adr-toolkit. NE PAS éditer à la main. -->

- `packages/codegraph/src/facts/index.ts`
- `packages/datalog/src/canonical.ts`
- `packages/datalog/src/facts-loader.ts`
- `packages/datalog/src/parser.ts`
- `packages/datalog/src/runner.ts`
- `packages/datalog/src/types.ts`


## Tested by

- `packages/datalog/tests/runner.test.ts` — exécute les rules sur facts
  fixtures, vérifie outputs déterministes.
- `packages/datalog/tests/parser.test.ts` — round-trip parse/serialize.
- `packages/datalog/tests/canonical.test.ts` — sort lex stable.
