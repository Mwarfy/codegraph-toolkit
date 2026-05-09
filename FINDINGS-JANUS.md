# Findings — dogfood codegraph-toolkit sur Janus (2026-05-08)

Installation complete des 6 packages publishables sur **Janus** (Next.js 16 + Supabase, ~3000 LOC, 48 fichiers TS/TSX, 1 dev). Stack TS pure + raw SQL migrations Postgres. Cible-cas typique du package `invariants-postgres-ts`.

Ce document liste les bugs concrets et points UX trouves pendant l'install + premier dogfood. Ordonne par criticite / fixabilite.

> **Cross-reference** : ce dogfood succede a [`docs/DOGFOODING-HAPPENIN.md`](docs/DOGFOODING-HAPPENIN.md) — meme stack (Next.js 16 + Supabase) mais projet plus petit / plus jeune. Plusieurs findings recoupent ; quand c'est le cas, je l'indique avec un lien vers le finding Happenin correspondant. **5 findings reellement nouveaux par rapport a Happenin** : F-002, F-003, F-005, F-006, F-007.

## TL;DR — etat des findings

| ID | Resume | Statut | Cross-ref Happenin |
|----|--------|--------|---------------------|
| **F-001** | `datalog-check` TypeError | ✅ Fix code (`0e83230` master) — 🟡 **action publication** : bump codegraph 0.6.1 + npm publish | F-002 Happenin |
| **F-002** | `codegraph-mcp@0.3.0` declare `codegraph: ^0.2.0`, importe `./diff` (>= 0.6.0 requis) | ✅ Fix code (PR #12) — 🟡 **action publication** : bump codegraph-mcp 0.3.1 + npm publish | (nouveau) |
| **F-003** | Multi-dir loader plante avec erreur cryptique sur clone canonical | ✅ Fix code (PR #12) — message d'erreur explicite avec fichier source + hint canonical | (nouveau) |
| **F-004** | `init` detecte "flat" pour Next.js | ✅ Fix code (PR #13) — nouveau layout `nextjs` + detection `supabase/migrations/` | F-010 Happenin |
| **F-005** | DEP-UNUSED faux positif sur CLI tools (toolkit s'auto-flag) | ✅ Fix code (PR #12) — packages avec `bin` field exemptes | (nouveau) |
| **F-006** | `cross-check` ne resout pas les rules cross-cut depuis node_modules | ✅ Fix code (PR #12) — fallback auto sur `node_modules/@liby-tools/runtime-graph/rules/` | (nouveau) |
| **F-007** | `init` cree `tests/unit/datalog-invariants.test.ts` sans installer vitest | ✅ Fix code (PR #13) — skip + warning explicite si vitest absent | (nouveau) |
| **F-008** | `invariants-postgres-ts` PAS publie sur npm (404) | 🟡 **action publication** : `cd packages/invariants-postgres-ts && npm publish` (publishConfig OK, 0.1.0 ready) | (different de F-004 Happenin qui parle du peer range) |
| **F-009** | `proxy.ts` flag orphan (Next 16) | ✅ Fix code (PR #6, etendu PR #8/#10) — 🟡 **action publication** : meme bump que F-001 | F-009 Happenin |

**Etat code** : 7/9 findings code-side **completement fix** (F-002, F-003, F-004, F-005, F-006, F-007, F-009). F-001 fix sur master mais pas encore publie. F-008 est purement une action de release.

**Action publication restante** (non-code, ops) :
1. `cd packages/codegraph && npm publish` (bump 0.6.0 → 0.6.1) → resout F-001 + F-009 + side-effect P0-P4 OSS-AUDIT
2. `cd packages/codegraph-mcp && npm publish` (bump 0.3.0 → 0.3.1) → resout F-002
3. `cd packages/adr-toolkit && npm publish` (bump 0.3.0 → 0.3.1) → propage F-004 + F-007
4. `cd packages/invariants-postgres-ts && npm publish` (premiere publication a 0.1.0) → resout F-008

---

## P0 — bugs bloquants

### F-001 — `codegraph datalog-check` plante (TypeError)

**Severite** : critique (la commande publique de la CLI pour Tier 8 est cassee)
**Versions** : `@liby-tools/codegraph@0.6.0` + `@liby-tools/datalog@0.3.0`
**Repro** : `npx codegraph datalog-check --rules-dir invariants/`

**Erreur** :
```
TypeError: Cannot read properties of undefined (reading 'get')
    at runRulesWithTimeout (.../codegraph/dist/cli/commands/datalog-check.js:81:27)
```

**Cause racine** : mismatch d'API entre `codegraph@0.6.0` et `datalog@0.3.0`.

`runFromDirs` retourne `Promise<{ program: Program; result: RunResult }>` (cf. `packages/datalog/src/runner.ts:21`).

Le code de `datalog-check.js` traite le retour comme si c'etait `RunResult` directement :

```js
// dist/cli/commands/datalog-check.js:80-82
const result = raced;
return result.outputs.get('Violation') ?? [];
//            ^^^^^^^ undefined — il faut result.result.outputs
```

**Fix** : changer `result.outputs` en `result.result.outputs` (et adapter le typage en amont).

**Workaround utilise sur Janus** : on appelle directement le binaire `codegraph-datalog-check-fast` (qui marche) via un wrapper `scripts/datalog-check.mjs`.

**Impact** : la commande la plus avancee (Tier 8 live gate) est inutilisable telle quelle. Les utilisateurs qui suivent le quickstart et tapent `codegraph datalog-check` se cognent direct.

---

### F-002 — `codegraph-mcp@0.3.0` declare un peer outdated qui plante au runtime

**Severite** : haute (le MCP server ne demarre pas du tout dans une install propre)
**Repro** : `pnpm add -D @liby-tools/codegraph @liby-tools/codegraph-mcp` puis `npx codegraph-mcp`

**Erreur** :
```
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './diff' is not defined
by "exports" in node_modules/@liby-tools/codegraph/package.json
    at .../codegraph-mcp/dist/tools/changes-since.js
```

**Cause racine** : `codegraph-mcp@0.3.0/package.json` declare :

```json
"dependencies": {
  "@liby-tools/codegraph": "^0.2.0",
  "@liby-tools/datalog":   "^0.2.0"
}
```

Mais le code importe `@liby-tools/codegraph/diff` qui n'existe que depuis `codegraph@0.6.0` (les exports `0.2.0` sont `.`, `./synopsis`, `./synopsis/adr-markers` — pas `./diff`).

**Fix** : bump les dependencies de `codegraph-mcp` a :

```json
"dependencies": {
  "@liby-tools/codegraph": "^0.6.0",
  "@liby-tools/datalog":   "^0.3.0"
}
```

**Workaround utilise sur Janus** : `pnpm.overrides` :

```json
"pnpm": {
  "overrides": {
    "@liby-tools/codegraph-mcp>@liby-tools/codegraph": "^0.6.0",
    "@liby-tools/codegraph-mcp>@liby-tools/datalog":   "^0.3.0"
  }
}
```

**Impact** : tout dev qui suit le `Quickstart 30 secondes` et veut activer le MCP server (point 4 du README) se bloque ici.

---

## P1 — bugs UX moyens

### F-003 — Multi-dir loader plante avec une erreur cryptique sur clones du canonical

**Severite** : moyenne (mauvaise pedagogie + erreur peu claire)
**Repro** :

1. `pnpm add -D @liby-tools/invariants-postgres-ts`
2. Copier les `.dl` du package en local : `cp node_modules/@liby-tools/invariants-postgres-ts/invariants/*.dl invariants/`
3. `node node_modules/@liby-tools/codegraph/scripts/datalog-check-fast.mjs .`

**Erreur** :
```json
{"error":"DatalogError: relation 'ArticFloatingGrandfathered' declared in
multiple files (already in '17', re-declared in
'invariants/composite-articulation-with-floating-promise.dl')"}
```

**Problemes** :

1. Le numero `'17'` n'est pas explicite — c'est probablement un `relationIndex` ou ID interne. Devrait etre le nom de fichier source de la 1ere declaration.
2. Le pattern "ne PAS copier les rules canoniques" n'est pas tellement mis en avant dans le README. Le user qui voit `runFromDirs({ rulesDir: [canonical, 'sentinel-core/invariants'] })` peut interpreter qu'il faut populer son dir local.

**Suggestions** :

- **(a)** Detecter au load les fichiers identiques par hash et soit warn ("you cloned the canonical rules — remove your local copy") soit dedupe silently.
- **(b)** Erreur plus claire : `relation 'X' declared in 'a/file.dl' and re-declared in 'b/file.dl' (relations cannot be redeclared across dirs)`.
- **(c)** Doc plus explicite dans `invariants-postgres-ts/README.md` : "**ne JAMAIS copier les rules dans ton projet — elles sont chargees automatiquement depuis node_modules**".

---

### F-004 — `adr-toolkit init` detecte "flat" pour les projets Next.js App Router

**Severite** : moyenne (faut tout reconfigurer a la main)
**Repro** : init dans un projet Next.js 13+ avec `app/`, `lib/`, `components/`, `proxy.ts` (ou `middleware.ts`).

**Output** : `Layout détecté : flat` — alors que la stack est evidemment Next.js.

**Config generee** :

```json
{
  "rootDir": ".",
  "include": ["**/*.{ts,tsx}"],
  "entryPoints": ["index.ts", "main.ts"],
  "detectorOptions": {
    "sqlSchema": { "enabled": false }
  }
}
```

**Problemes** :

- `entryPoints: ["index.ts", "main.ts"]` n'a aucun sens en Next.js
- `include: "**/*.{ts,tsx}"` capture trop large (par defaut, on veut probablement `app/`, `lib/`, `components/` + `proxy.ts`/`middleware.ts`)
- `sqlSchema.enabled: false` meme si `supabase/migrations/*.sql` existe — la detection raw SQL devrait etre auto

**Suggestion** : ajouter un layout `nextjs` dans `detectLayout()` :

```ts
if (await exists('next.config.ts') || await exists('next.config.js')) {
  return {
    layout: 'nextjs',
    srcDirs: ['app', 'lib', 'components'].filter(exists),
    entryPoints: ['proxy.ts', 'middleware.ts'].filter(exists),
    sqlSchema: await exists('supabase/migrations'),
    drizzleSchema: await exists('drizzle.config.ts'),
  }
}
```

---

### F-005 — `DEP-UNUSED` faux positif sur les CLI tools (le toolkit lui-meme!)

**Severite** : moyenne (auto-defait — le toolkit declare ses propres deps comme "non utilisees")
**Repro** : installer `@liby-tools/codegraph @liby-tools/adr-toolkit @liby-tools/datalog @liby-tools/salsa @liby-tools/runtime-graph`, faire `npx codegraph analyze` puis `npx adr-toolkit brief`.

**Output** dans `CLAUDE-CONTEXT.md` :

```
- DEP-UNUSED `@liby-tools/adr-toolkit` — declare dans package.json, jamais importe
- DEP-UNUSED `@liby-tools/codegraph` — declare dans package.json, jamais importe
- DEP-UNUSED `@liby-tools/datalog` — declare dans package.json, jamais importe
- DEP-UNUSED `@liby-tools/runtime-graph` — declare dans package.json, jamais importe
- DEP-UNUSED `@liby-tools/salsa` — declare dans package.json, jamais importe
```

C'est techniquement correct (ces packages sont utilises via `npx <bin>`, pas par `import`), mais c'est un faux positif tres visible sur le boot brief — ironiquement, le toolkit s'auto-shame.

**Suggestion** : detecter les packages avec `bin` field dans leur `package.json` et les whitelister automatiquement, ou exposer une option `packageDeps.allowlistBins: true`.

---

### F-006 — `codegraph cross-check` ne resout pas les rules cross-cut canoniques automatiquement

**Severite** : faible (UX)
**Repro** : `npx codegraph cross-check`

**Output** :
```
no .dl rule found in /path/.codegraph/rules-cross-cut
```

**Probleme** : alors que `@liby-tools/runtime-graph/rules/` contient les 18 rules cross-cut canoniques (`composite-cycle-runtime-confirmed.dl`, `runtime-dead-handler.dl`, etc.). L'utilisateur doit explicitement passer `--rules-dir node_modules/@liby-tools/runtime-graph/rules`.

**Suggestion** : `cross-check` devrait etre symetrique a `datalog-check-fast` et auto-resoudre les rules canoniques depuis `node_modules/@liby-tools/runtime-graph/rules/` quand le default `<root>/.codegraph/rules-cross-cut` n'existe pas.

---

## P2 — points UX mineurs

### F-007 — `init` cree un test vitest sans installer vitest

**Severite** : faible (le pre-commit hook est OK car la variable d'env `ADR_TOOLKIT_INVARIANT_TESTS` est vide par defaut, le test n'est jamais lance)
**Repro** : `npx adr-toolkit init` dans un projet sans vitest

**Effet** : `tests/unit/datalog-invariants.test.ts` est cree mais l'import `from 'vitest'` echoue si on essaie de le lancer.

Le fichier *gere* gracieusement l'absence du package via try/catch, mais devrait :

- Soit instller vitest comme devDep si on accepte l'option
- Soit ne pas creer le test du tout
- Soit creer un test runnable avec `node:test` (sans dep) en alternative

Le `--with-claude-hooks` ne resoud pas non plus le besoin de runner les invariants au pre-commit puisque le hook par defaut n'execute pas vitest sans config explicite.

---

### F-008 — README install command pour `invariants-postgres-ts` echoue (404 npm)

**Severite** : haute si on suit le quickstart litterallement
**Repro** : `npm install --save-dev @liby-tools/invariants-postgres-ts`

**Erreur** :
```
ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/@liby-tools%2Finvariants-postgres-ts:
Not Found - 404
```

**Cause** : le package n'est PAS publie sur npm, contrairement a ce que dit le README :

> `@liby-tools/invariants-postgres-ts` ... `0.1.0` ... `published`

**Suggestions** :

- Soit publier sur npm (recommande, c'est le coeur des 91 rules)
- Soit corriger le tableau du README pour dire "vendor only" + documenter le pattern `pnpm add -D file:./packages/invariants-postgres-ts/...tgz`

**Workaround utilise** : install depuis le tarball local (`liby-tools-invariants-postgres-ts-0.1.0.tgz`).

---

### F-009 — `proxy.ts` (Next.js 16 routing middleware) flag comme orphelin

**Severite** : faible
**Repro** : Next.js 16 projet avec `proxy.ts` a la racine. Meme si declare dans `entryPoints: ["proxy.ts"]`, le detecteur le flag comme `COMPOSITE-ORPHAN-FILE`.

**Cause probable** : le detecteur d'orphans ne lit pas `entryPoints` de la config, ou alors le matching path est strict (`./proxy.ts` vs `proxy.ts`).

**Suggestion** : reconnaitre `proxy.ts` (Next 16) et `middleware.ts` (Next 13-15) comme entry points natifs de Next.js, sans config explicite.

---

## Recap fixes proposes

| ID | Action | Lieu | Effort |
|----|--------|------|--------|
| F-001 | Fix `result.outputs` → `result.result.outputs` | `packages/codegraph/src/cli/commands/datalog-check.ts:81` | 5 min |
| F-002 | Bump deps `codegraph-mcp` → `^0.6.0` / `^0.3.0` | `packages/codegraph-mcp/package.json` | 2 min |
| F-003 | Erreur multi-dir avec filename source + warning sur clones | `packages/datalog/src/runner.ts` | 30 min |
| F-004 | Layout `nextjs` dans init | `packages/adr-toolkit/src/init.ts` | 30 min |
| F-005 | Whitelist packages avec `bin` field | `packages/codegraph/src/extractors/package-deps.ts` | 20 min |
| F-006 | Auto-resolve rules cross-cut depuis node_modules | `packages/codegraph/src/cli/commands/cross-check.ts` | 15 min |
| F-007 | Skip test creation OR utiliser node:test | `packages/adr-toolkit/src/init.ts` | 20 min |
| F-008 | Publier `invariants-postgres-ts` sur npm | npm publish | 5 min + check |
| F-009 | Reconnaitre `proxy.ts`/`middleware.ts` comme entry points Next | `packages/codegraph/src/extractors/...` | 15 min |

Les fixes F-001 et F-002 sont **les deux bloquants reels** — un dev qui suit le quickstart se prend les deux dans la tete. Les autres sont des polish.

---

## Note sur le dogfood Janus lui-meme

Une fois les workarounds en place :

- **108 rules** loadees (canonical only via node_modules)
- **29 violations** detectees au baseline initial sur 48 fichiers TS/TSX
  - 11 `COMPOSITE-AWAIT-IN-LOOP` dans `lib/strava/{client,oauth}.ts` (probablement intentionnels — retry/backoff)
  - 3 `COMPOSITE-CYCLOMATIC-BOMB` (`StravaClient.fetchWithRetry` cyclomatic 17, `tokenRequest` 17, `ProfileForm` 24)
  - 2 `COMPOSITE-COGNITIVE-BOMB` (les deux memes Strava fns)
  - 3 `COMPOSITE-ORPHAN-FILE` (`proxy.ts` faux positif F-009 + 2 vrais positifs UI shadcn non utilises)
  - 1 `COMPOSITE-DEP-UNUSED` (`@liby-tools/adr-toolkit` — F-005 faux positif)
  - 1 `SQL-ORPHAN-FK` dans `supabase/migrations/0001_init_foundation.sql:11` — vrai positif probable, FK vers une table `auth.users` que le detecteur ne voit pas (schema externe Supabase). Possible amelioration: declarer un seed des schemas externes connus (auth.*, storage.*) pour Supabase.

Apres workarounds, le toolkit donne du vrai signal en 2.5s par analyze + 35ms par datalog-check. **Verdict : utile** sur ce profil de projet, modulo les 9 frictions ci-dessus.
