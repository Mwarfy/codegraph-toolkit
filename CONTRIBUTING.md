# Contributing

## Setup dev

```bash
nvm use && npm install && npm run build && npm test
```

Les 2 packages tournent en parallèle via `tsc -b` (project references). Watch mode : `npm run build -- --watch`.

## Structure des packages

```
packages/codegraph/      → analyseur statique pur, pas de dépendance projet
packages/adr-toolkit/    → gouvernance ADR, dépend de @liby-tools/codegraph
examples/minimal/        → consommateur de validation (workspace)
```

## Règles fondamentales (non négociables)

### 1. Zéro LLM dans le synopsis builder

`@liby-tools/codegraph buildSynopsis` est **pur**. Aucun I/O, aucun LLM, aucun random. Même snapshot → output byte-identique. Test `synopsis-determinism` verrouille cette propriété.

Si tu trouves un raccourci qui demande de l'I/O dans le builder, c'est probablement un bug de design — refactor en passant l'info par `options`.

### 2. Config-driven, pas hardcoded

`@liby-tools/adr-toolkit` lit `.codegraph-toolkit.json` du projet consommateur. Aucun path Sentinel-spécifique ou Morovar-spécifique ne doit apparaître dans le code du toolkit.

### 3. Tests sur fixtures synthétiques

Chaque module migré a au moins 1 test sur fixture synthétique (vitest). Ne pas se reposer sur "ça marche sur Sentinel" — les tests doivent vivre dans le toolkit pour être autonomes.

Les fixtures synthétiques sont des **contrats** : si tu changes l'API publique, change la fixture et le test ensemble.

## Convention de tests

### Tests vitest (par défaut)

`packages/<pkg>/tests/*.test.ts` avec `describe/it/expect`. Vitest config exclut `tests/fixtures/**` (fichiers d'input pour les tests, pas des tests eux-mêmes).

```bash
npm test                         # Tous les tests vitest
npx vitest run packages/foo      # Un seul package
```

### Tests legacy (codegraph)

15 tests historiques dans `packages/codegraph/tests/*.test.ts` utilisent `node:assert` + le pattern `run().catch(err)` (scripts plats, pas vitest). Exclus de `npm test` par la `vitest.config.ts`.

Pour les exécuter : `tsx packages/codegraph/tests/<name>.test.ts`. Conversion vitest = follow-up éventuel, pas prioritaire.

## Convention de versioning

Semver. On est en `0.x` donc breaking allowed mais documenté dans `CHANGELOG.md`.

Avant de bumper une version :
1. `npm run build && npm test` → vert
2. Update `CHANGELOG.md` avec les changements
3. `npm version <patch|minor|major> --workspaces`

## Ajouter une feature

1. Décide quel package : analyseur pur (codegraph) ou gouvernance ADR (adr-toolkit) ?
2. Ajoute la fonction + ses types dans le module approprié
3. Re-export dans `src/index.ts` si API publique
4. CLI command si pertinent (`src/cli/index.ts`)
5. Test sur fixture synthétique (`tests/<feature>.test.ts`)
6. `npm run build && npm test` doit passer
7. Update `README.md` si nouvelle commande/option visible utilisateur
8. Update `CHANGELOG.md`

## Ajouter un consommateur

1. Le projet doit avoir un `tsconfig.json` à la racine (ou path configurable)
2. `cd <projet> && npm link @liby-tools/codegraph @liby-tools/adr-toolkit`
3. `npx adr-toolkit init` (idempotent — skip ce qui existe déjà)
4. Customiser `.codegraph-toolkit.json` si besoin (`srcDirs`, `briefCustomSections`)
5. Premier ADR avec `_TEMPLATE.md` + marqueur dans le code
6. `npx adr-toolkit regen && npx adr-toolkit brief` — vérifier le brief généré

## CI / hooks

Les hooks templates (`packages/adr-toolkit/src/hooks/`) sont génériques. Le projet consommateur les copie via `adr-toolkit init` — peut les éditer ensuite pour ajouter ses propres steps (tsc, tests d'invariant) via env vars `ADR_TOOLKIT_RUN_TSC`, `ADR_TOOLKIT_INVARIANT_TESTS`, etc.

## Pièges fréquents

- **`workspace:*`** : non supporté par npm. Utiliser `"*"` pour les deps inter-workspaces.
- **Node ≥22** : nécessaire pour vitest 4. Les hooks doivent sourcer nvm (déjà fait dans les templates).
- **Marqueurs en prose** : `// cf. ADR-013` ne match pas, le matcher exige `ADR-NNN` en début de commentaire.
- **`execSync('cat')`** : le `maxBuffer` default est 1 MB, le snapshot codegraph fait 2-3 MB. Toujours `readFileSync` direct.
