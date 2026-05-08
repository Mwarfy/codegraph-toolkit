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

## ✅ Résolu (suite — batch 2)

### F-006 · Détecteur SQL ne reconnaît pas le schéma `auth` Supabase

**Symptôme initial** : 2 violations `SQL-ORPHAN-FK` sur Happenin sur des
FK `references auth.users(id)` — table managed par Supabase, pas un
orphan. Pattern systémique sur tout projet Supabase.

**Fix appliqué** :
1. `stripSchema(qualifiedName)` ne strip que le schéma `public.` (default,
   omissible). Tout autre préfixe (`auth.`, `storage.`, `realtime.`,
   `vault.`) est préservé dans les facts `SqlForeignKey`.
2. `sql-orphan-fk.dl` enrichi d'un fact `SupabaseManagedTable(t)` listant
   24 tables managed par Supabase Auth/Storage/Realtime/Vault. La rule
   exempte les FKs vers ces tables.

Validation fixture : `auth.users(id)` → plus de SQL-ORPHAN-FK reportée.
Les FK vers tables locales orphelines restent flaggées.

### F-007 · Rule `SQL-NAMING-CONVENTION` flag les colonnes `_by`

**Symptôme initial** : 3 violations Happenin sur `created_by`, `reviewed_by`,
`resolved_by` (idiome Postgres standard pour colonnes audit/workflow).

**Fix appliqué** : `checkForeignKeyIdSuffix` (sql-naming.ts) accepte la
liste `_id`, `_by`, `_to`, `_for` au lieu d'exiger seulement `_id`. Couvre
les patterns audit (`created_by`, `updated_by`), workflow (`assigned_to`,
`approved_by`), et planification (`scheduled_for`).

### F-008 · Rule `SQL-AUDIT-COLUMNS` rigide pour les tables append-only

**Symptôme initial** : `push_tokens` flagué `audit-column-missing-updated-at`
alors que la table est INSERT-only (UPSERT via UNIQUE constraint).

**Fix appliqué** : marqueur SQL `-- @append-only` parsé par `sql-schema.ts`
dans les 5 lignes précédant le `CREATE TABLE`. Quand présent, la table
est marquée `appendOnly: true` et `checkAuditColumns` (sql-naming.ts)
exempte cette table de l'exigence `updated_at`.

Exemple :

```sql
-- @append-only
CREATE TABLE push_tokens (
  id UUID PRIMARY KEY,
  ...
);
```

Validation fixture : `push_tokens` avec marker → pas de violation.
`orders_2` sans marker ni `updated_at` → violation BIEN reportée.

---

## 💡 Suggestions

### F-009 · Reconnaître les fichiers test colocalisés sous `app/` (Next.js) ✅ Résolu

> Resolu par PR [#6](https://github.com/Mwarfy/codegraph-toolkit/pull/6) (mergee).

**Fix applique** : `core/framework-conventions.ts` etendu avec :
- `isTestEntryPoint()` matche `*.test.{ts,tsx}`, `*.spec.{ts,tsx}`,
  `*.stories.{ts,tsx}`, `__tests__/`
- `isScriptEntryPoint()` matche `scripts/`, `bin/`
- ajout `proxy` (Next.js 16) et `vercel` (Vercel TS config 2026) aux
  basenames reconnus
- ajout `vitest.setup`, `jest.setup` aux configs implicites

Workaround `codegraph.config.json#entryPoints` n'est plus necessaire pour
ces patterns universels.

### F-010 · `codegraph init` génère-t-il un config Supabase-aware ?

Sur Happenin, le `codegraph.config.json` final fait 50 lignes pour absorber :

- include élargi (e2e, scripts, mobile, supabase/functions)
- entryPoints projet (tests, stories, e2e, scripts, supabase functions, test setup, eslint config)
- detectorOptions.sqlSchema.globs (workaround pour F-005)

Une commande `codegraph init --stack supabase-nextjs` qui génère ce config
out-of-the-box ferait gagner ~30min à chaque nouveau projet du genre.

### F-011 · Faux positif CWE-918 sur fetch d'env var ✅ Résolu

**Symptôme initial** : `fetch(process.env.WEBHOOK_URL)` flaggué CWE-918
(SSRF) alors que `process.env` est admin-controlled, pas user input.

**Fix appliqué** : `cwe-918-ssrf.dl` ajoute la contrainte
`Source != "process.env"` dans la matching rule. Les patterns
`fetch(req.body.url)`, `fetch(req.query.url)` continuent de trigger
correctement.

Validation fixture :
- `fetch(req.body.url)` → CWE-918 reportée ✓
- `fetch(process.env.WEBHOOK_URL)` → pas de violation ✓

---

## Stats globales

Sur Happenin après les fixes (F-001 à F-005 appliqués + workarounds projet ;
batch 2 ci-dessous resout F-006/F-007/F-008/F-011 et permet de retirer
les workarounds correspondants) :

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
