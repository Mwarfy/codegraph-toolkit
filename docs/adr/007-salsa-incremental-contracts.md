---
asserts:
  - symbol: "incremental/queries#fileContent"
    exists: true
  - symbol: "incremental/queries#projectFiles"
    exists: true
  - symbol: "incremental/database#sharedDb"
    exists: true
---

# ADR-007: Salsa incremental — fileContent + sharedDb sont contrats canoniques

**Date:** 2026-05-03
**Status:** Accepted

## Rule

> `incremental/queries.ts` et `incremental/database.ts` sont les **points
> d'entrée canoniques** pour toute computation incrémentale Salsa. Ne JAMAIS
> instancier `new SalsaDatabase()` ailleurs (cassérait le caching). Toujours
> consommer la `sharedDb` exportée + déclarer les inputs via les `input()` de
> `queries.ts`. Les `derived()` consument fileContent / projectFiles, pas le
> filesystem direct.

## Why

22+ extracteurs sont incrémentaux (cf. `incremental/`) et partagent UNE
SEULE Salsa database. Si un extracteur instancie sa propre DB, les
invalidations cross-extracteur cassent (un changement de fichier ne
revoque pas les caches d'un autre extracteur). Symptôme observé :
détecteur dead-code voyait des fichiers déjà supprimés du dépôt parce
qu'il avait sa propre DB qui n'était pas notifée des deletes.

## How to apply

Faire :
- `import { sharedDb } from '../incremental/database.js'` puis `derived(sharedDb, ...)`.
- Lire le contenu d'un fichier via `fileContent.get(path)`, jamais via `fs.readFile()`.
- Lister les fichiers via `projectFiles.get(label)`.

Ne plus faire :
- `new SalsaDatabase()` — réservé à la fonction unique `sharedDb`.
- `await fs.readFile(...)` dans un detector — bypass le invalidation tracking.
- Modifier directement `fileContent` — passer par `setInput` du store.

Cas limite : tests qui veulent un Salsa isolé peuvent créer leur propre
DB via `new SalsaDatabase()` LOCAL au test, jamais exporté.

## Anchored in

<!-- AUTO-GÉNÉRÉ depuis les marqueurs ADR-NNN du code source. Voir @liby-tools/adr-toolkit. NE PAS éditer à la main. -->

- `packages/codegraph/src/incremental/barrels.ts`
- `packages/codegraph/src/incremental/complexity.ts`
- `packages/codegraph/src/incremental/cycles.ts`
- `packages/codegraph/src/incremental/data-flows.ts`
- `packages/codegraph/src/incremental/database.ts`
- `packages/codegraph/src/incremental/env-usage.ts`
- `packages/codegraph/src/incremental/event-emit-sites.ts`
- `packages/codegraph/src/incremental/metrics.ts`
- `packages/codegraph/src/incremental/oauth-scope-literals.ts`
- `packages/codegraph/src/incremental/package-deps.ts`
- `packages/codegraph/src/incremental/persistence.ts`
- `packages/codegraph/src/incremental/project-cache.ts`
- `packages/codegraph/src/incremental/queries.ts`
- `packages/codegraph/src/incremental/state-machines.ts`
- `packages/codegraph/src/incremental/symbol-refs.ts`
- `packages/codegraph/src/incremental/taint.ts`
- `packages/codegraph/src/incremental/truth-points.ts`
- `packages/codegraph/src/incremental/ts-imports.ts`
- `packages/codegraph/src/incremental/typed-calls.ts`
- `packages/codegraph/src/incremental/unused-exports.ts`
- `packages/codegraph/src/incremental/watcher.ts`


## Tested by

- `packages/codegraph/tests/incremental.test.ts` — vérifie le caching cross-extracteur
- `packages/salsa/tests/database.test.ts` — invariants Salsa core
