# Dogfooding sur Happenin — findings 2026-05-08

Notes de dogfooding du toolkit `@liby-tools/codegraph@0.6.0` sur le projet
[Happenin](https://github.com/smurfy92/happenin) (Next.js 16 App Router +
Supabase + ~85 migrations Postgres + monorepo Expo + Sentry triple config,
~700 fichiers TS, 3640 unit tests, 99.37% coverage).

L'objectif : remonter ce qui a coincé pour qu'on puisse améliorer
le toolkit avant de le pousser à d'autres projets.

## Légende

- ✅ **Résolu** — PR mergée
- 🚧 **En cours** — PR ouverte
- 🔵 **À traiter** — pas encore de PR, contexte ci-dessous
- 💡 **Suggestion** — nice-to-have, non bloquant

---

## ✅ Résolu

### F-001 · Détecteur orphans ne reconnaît pas Next.js App Router / Expo Router / Sentry / configs implicites

PR [#1](https://github.com/Mwarfy/codegraph-toolkit/pull/1) mergée.

**Symptôme** : sur Happenin (Next.js 16 App Router + Expo monorepo + Sentry
triple config), `codegraph orphans` retournait health 50 % avec 254 orphans
sur 517 fichiers — la majorité des `page.tsx` / `layout.tsx` / `route.ts` /
`middleware.ts` / `instrumentation*.ts` / configs `sentry.{client,server,edge}.config.ts`
marqués orphans car le runtime les charge par convention de fichier, pas
par import explicite.

**Cause racine** : la logique `isNextJsRouteFile` / `isToolConfigFile` existait
déjà dans `extractors/unused-exports.ts` (Fix M-008/M-010) mais n'était pas
réutilisée par `core/graph.ts#isEntryPoint()`.

**Fix** : module `core/framework-conventions.ts` comme single source of
truth, + ajouts Expo Router, Sentry triple config, Nuxt/Astro/Svelte/Rollup,
`instrumentation-client.ts`.

**Impact** : health 50 % → 60 % avec juste le fix toolkit.

### F-002 · `datalog-check` plante au premier run

PR [#1](https://github.com/Mwarfy/codegraph-toolkit/pull/1) mergée
(commit `0e83230`).

**Symptôme** :

```
TypeError: Cannot read properties of undefined (reading 'get')
  at runRulesWithTimeout (datalog-check.js:81:27)
```

**Cause racine** : `@liby-tools/datalog#runFromDirs` retourne
`{ program, result: { outputs, stats } }` (cf. `packages/datalog/src/runner.ts:42`
+ `packages/datalog/src/types.ts:266`). Le call site dans `datalog-check.ts`
lisait `raced.outputs` au lieu de `raced.result.outputs`.

La type signature de `loadDatalogRunner` était périmée ; le `as any` à
l'import effaçait la vraie shape.

**Fix** : 1 ligne de correction d'accès + type signature alignée.

### F-003 · ESLint flat config (`eslint.config.{js,mjs,cjs,ts}`) marqué orphan

PR [#1](https://github.com/Mwarfy/codegraph-toolkit/pull/1) mergée
(commit `e54ad7b`).

**Cause racine** : ESLint 9+ utilise le format flat config chargé
implicitement par eslint runtime, jamais importé. Pas dans `TOOL_CONFIG_BASENAMES`.

**Fix** : ajout de `eslint.config` à la whitelist.

### F-004 · CI rouge sur master à cause d'un peer range trop strict

PR [#2](https://github.com/Mwarfy/codegraph-toolkit/pull/2) mergée.

**Symptôme** : `npm ci` échouait avec ERESOLVE depuis le bump `codegraph@0.4`.

**Cause racine** : `packages/invariants-postgres-ts/package.json` déclarait
`"@liby-tools/codegraph": "^0.3.0"` qui en semver pre-1.0 signifie
`>=0.3.0 <0.4.0` — exclut `0.4`, `0.5`, `0.6`.

**Fix** : `>=0.3.0` (range ouvert vu que ce package contient uniquement des
fichiers `.dl` consommés en lecture, sans dépendance à une API JS particulière).

---

## 🚧 En cours

### F-005 · `config.exclude` ignoré par `sql-schema-detector`

PR [#4](https://github.com/Mwarfy/codegraph-toolkit/pull/4) ouverte.

**Symptôme** : sur Happenin, `codegraph.config.json` avec
`"exclude": ["docs/migration-drift/**"]` — le détecteur SQL continuait à
scanner ce dossier. Conséquence : 7 doublons de violations
(3 SQL-FK-INDEX, 4 SQL-NAMING-CONVENTION, 2 SQL-ORPHAN-FK, 1 SQL-AUDIT-COLUMNS)
sur des rows déjà présentes dans les migrations canoniques.

**Cause racine** : `extractors/sql-schema.ts#discoverSqlFiles` walk depuis
`rootDir` avec sa propre `SKIP_DIRS` hardcodée (`node_modules`, `dist`,
`coverage`, `.turbo`, `.cache`, `docker-data`, `rollbacks`). Aucune
consommation de `config.exclude` — contrairement aux extracteurs TS.

Le détecteur `sql-schema-detector.ts#run` ne propageait pas non plus
`ctx.config.exclude` à `analyzeSqlSchema`.

**Fix proposé** : paramètre `excludes` optionnel sur `discoverSqlFiles` et
`analyzeSqlSchema` (rétro-compatible default `[]`), propagation depuis le
détecteur.

**Workaround projet en attendant** : `detectorOptions.sqlSchema.globs` qui
scope positivement aux dossiers wanted. Moins ergonomique car il faut
recopier la liste include au lieu de réutiliser l'`exclude` unique.

---

## 🔵 À traiter

### F-006 · Détecteur SQL ne reconnaît pas le schéma `auth` Supabase

**Symptôme** : sur Happenin, 2 violations `SQL-ORPHAN-FK` :

- `001_initial_schema.sql:5` → `references auth.users(id)`
- `064_web_push_subscriptions.sql:19` → `references auth.users(id) ON DELETE CASCADE`

Le message « FK vers table inexistante — reliquat refactor migration ;
supprimer ou corriger le ref » est trompeur : `auth.users` est une table
managed par Supabase (schéma `auth`), pas un orphan.

**Pourquoi c'est gênant** : la quasi-totalité des projets Supabase ont des
FK vers `auth.users` — c'est l'idiome standard pour lier une row métier à
un user authentifié. Sans whitelist, le toolkit produit du bruit
systématique sur tout projet Supabase.

**Pistes de fix** :

1. **Whitelist hardcodée des schémas Supabase** : `auth`, `storage`,
   `realtime`, `vault`, `extensions`, `pgsodium`, `graphql`. Le détecteur
   ne flag pas les FK qui référencent ces schémas.
2. **Option config** `detectorOptions.sqlSchema.allowedExternalSchemas: string[]`
   pour permettre à l'utilisateur d'ajouter ses propres schémas managed.
3. **Auto-détection** : si une migration contient `create extension if not
   exists ...`, ajouter le schéma de l'extension à la whitelist runtime.

**Workaround projet** : aucun élégant — il faudrait baseline ces 2 violations
ou accepter le bruit.

### F-007 · Rule `SQL-NAMING-CONVENTION` flag les colonnes `_by` (auteur d'action)

**Symptôme** : sur Happenin, 3 violations sur des colonnes au pattern
`<verb>_by` :

- `001_initial_schema.sql:20` → `created_by uuid`
- `030_photo_moderation.sql:13` → `reviewed_by uuid`
- `035_event_stories.sql:71` → `resolved_by uuid`

Le message dit « voir kind (snake_case, _at suffix, _id suffix) » — apparemment
la rule veut que les colonnes UUID se terminent en `_id`.

**Pourquoi c'est gênant** : le pattern `<verb>_by` est un idiome Postgres
parfaitement standard pour les colonnes d'audit/auteur d'action :

- `created_by`, `updated_by`, `deleted_by` — qui a fait l'action
- `reviewed_by`, `approved_by`, `assigned_to` — workflow patterns
- `resolved_by`, `closed_by` — état machine

Tous ces noms communiquent une SÉMANTIQUE différente d'un FK généraliste
(p. ex. `user_id`). Renommer en `created_by_id` est verbeux et casse
l'idiome.

**Pistes de fix** :

1. **Whitelist suffix `_by`** : si une colonne UUID finit par `_by` ET
   référence une table avec un PK uuid, considérer le naming valide.
2. **Option config** `detectorOptions.sqlNaming.allowedSuffixes: string[]`
   avec default `["_id", "_by", "_to"]`.
3. **Documenter** dans la rule `.dl` pourquoi `_id` est requis (probablement
   pour faciliter le matching avec les FK auto-detected) et permettre une
   exception explicite via commentaire SQL.

### F-008 · Rule `SQL-AUDIT-COLUMNS` rigide pour les tables append-only

**Symptôme** : sur Happenin, 1 violation `SQL-AUDIT-COLUMNS` sur
`011_push_tokens.sql:4` (table `push_tokens`).

La table est conçue **immutable** :

```sql
CREATE TABLE IF NOT EXISTS push_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, token)
);
```

L'application UPSERT (delete + insert sur conflit unique). `updated_at`
n'a aucun sens.

**Pourquoi c'est gênant** : forcer `updated_at` sur des tables append-only
introduit du noise mental ("on doit le mettre à jour à la main quand ?")
et du code applicatif inutile (triggers, hooks Supabase).

**Pistes de fix** :

1. **Heuristique** : si la table a une contrainte UNIQUE sur des colonnes
   non-PK ET pas d'`UPDATE` dans aucune migration, considérer append-only
   et skip la rule.
2. **Marqueur explicite** : convention de commentaire SQL `-- @append-only`
   au-dessus du `CREATE TABLE` qui désactive la rule sur cette table.
3. **Option config** `detectorOptions.sqlSchema.appendOnlyTables: string[]`
   avec liste des tables exemptées.

---

## 💡 Suggestions

### F-009 · Reconnaître les fichiers test colocalisés sous `app/` (Next.js)

Pas un bug, mais un défaut d'ergonomie : sur Happenin, ~150 fichiers
`*.test.tsx` colocalisés dans `src/app/**/` étaient marqués orphans
parce qu'ils ne sont importés par personne (vitest les charge par
convention `**/*.test.{ts,tsx}`).

Workaround projet en place dans `codegraph.config.json#entryPoints`.

**Suggestion** : ajouter `**/*.test.{ts,tsx}`, `**/*.spec.{ts,tsx}`,
`**/__tests__/**/*.{ts,tsx}` aux conventions framework reconnues dans
`core/framework-conventions.ts#isFrameworkEntryPoint`. Idem pour
`*.stories.{ts,tsx}` (Storybook).

Ces conventions sont universelles (vitest, jest, Storybook), pas
spécifiques à un projet.

### F-010 · `codegraph init` génère-t-il un config Supabase-aware ?

Sur Happenin, le `codegraph.config.json` final fait 50 lignes pour absorber :

- include élargi (e2e, scripts, mobile, supabase/functions)
- entryPoints projet (tests, stories, e2e, scripts, supabase functions, test setup, eslint config)
- detectorOptions.sqlSchema.globs (workaround pour F-005)

Une commande `codegraph init --stack supabase-nextjs` qui génère ce config
out-of-the-box ferait gagner ~30min à chaque nouveau projet du genre.

### F-011 · Faux positif CWE-918 sur fetch d'env var

Sur Happenin, 1 violation CWE-918 (SSRF) sur :

```ts
const url = process.env.DISCORD_CSAM_WEBHOOK_URL ?? process.env.DISCORD_WEBHOOK_URL;
const res = await fetch(url, { ... });
```

L'URL vient d'une env var ops, pas du user input. La rule trigger sur
toute `fetch(variable)` sans tracker l'origine env-vs-user.

**Suggestion** : ajouter un check « origin is `process.env` » dans la
règle `cwe-918.dl` pour exclure ce pattern (env vars sont admin-controlled).

---

## Stats globales

Sur Happenin après les fixes (F-001 à F-005 appliqués + workarounds projet) :

| Métrique | Avant | Après |
|---|---|---|
| Health code | 50 % | **100 %** |
| Orphans | 254 / 517 | **0 / 703** |
| `datalog-check` | crash TypeError | **1131 violations en 213ms** |
| SQL-FK-INDEX | 21 | **0** (mig 086 + 087 + dedupe 088) |
| Vraies violations actionables | ? | 0 critiques, 7 nuances stylistiques (cf. F-006/F-007/F-008) |

Le toolkit a déjà bien aidé à découvrir des choses concrètes côté Happenin
(11 FK sans index manquantes, drift dashboard de 15 index, 2 paires de
doublons identiques) qui ont chacune fait l'objet d'une migration commitée.

---

## Notes

Doc rédigée par smurfy92 pendant la session de dogfooding du 2026-05-08.
Bouge librement les sections, supprime ce qui est traité, ajoute ce que
tu vois sur d'autres projets si pertinent.
