# Dogfooding sur dpl-rag — findings 2026-05-08

Notes de dogfooding du toolkit `@liby-tools/codegraph@0.6.0` (master `ee3a58d`)
sur le projet [dpl-rag](https://github.com/digital-pharma-lab/rag-dpl) (Next.js 16
App Router + Supabase pgvector + AI Gateway + Sentry + Workflow, 59 fichiers TS,
~10 routes API dont 3 webhook proxies, deploy Vercel).

L'objectif : valider les fixes des PRs récentes (F-001 / F-005 / F-009 / F-011)
sur un 2e projet réel et remonter ce qui reste cassé ou contre-intuitif.

## Légende

- ✅ **Résolu** — PR mergée, validée sur dpl-rag
- 🔵 **À traiter** — nouveau bug ou friction, pas encore de PR
- 💡 **Suggestion** — nice-to-have, non bloquant

---

## ✅ Validations cross-project

### F-001 / F-009 · Next.js entry points correctement reconnus

Sur `npm install @liby-tools/codegraph@0.6.0` (npm registry, pré-fix) :

```
Stats — 59 files · 27 orphans · health 54%
```

Faux positifs : `app/layout.tsx`, `app/page.tsx`, `app/widget/page.tsx`,
`next.config.ts`, `proxy.ts`, `vercel.ts`, `instrumentation.ts`,
`instrumentation-client.ts`, `vitest.config.ts`, `playwright.config.ts`,
`*.test.tsx`, `scripts/*.ts`.

Sur master (post-batch3) avec build local :

```
Stats — 59 files · 0 orphans · health 100%
```

✅ Les 27/27 faux positifs ont disparu. Les fixes Happenin transposent.

### F-011 · CWE-918 process.env exempté

dpl-rag a 2 routes proxy (`sentry-discord`, `github-release-discord`) qui
font `fetch(process.env.WEBHOOK_URL)`. La rule `cwe-918-ssrf.dl` ne les
flag pas (filtre `Source != "process.env"` actif). ✅

---

## 🔵 À traiter

### F-101 · Cold `npm run build` échoue — tsc references manquantes

**Symptôme** : sur `git clone` + `npm install` + `npm run build` (mode
contributeur, install.sh `--dev`) :

```
packages/codegraph/src/cli/commands/datalog-check.ts(72,34): error TS2307:
  Cannot find module '@liby-tools/datalog' or its corresponding type declarations.
packages/codegraph/src/datalog-detectors/composite-runner.ts(34,56): error TS2307: ...
packages/codegraph/src/datalog-detectors/runner.ts(15,56): error TS2307: ...
packages/runtime-graph/src/cli.ts(601,30): error TS2307: ...
+ 4 cascade errors dans codegraph-mcp/datalog-query.ts
```

Le 2e build successif passe (les `dist/` partiellement générés au 1er run
font basculer la résolution module).

**Cause racine** : `packages/codegraph/tsconfig.json` et
`packages/runtime-graph/tsconfig.json` n'ont pas `{ "path": "../datalog" }`
dans `references`, alors que leur source importe `@liby-tools/datalog`.
`packages/codegraph-mcp/tsconfig.json` l'a (preuve que le pattern est connu).

```json
// packages/codegraph/tsconfig.json (actuel)
"references": [
  { "path": "../salsa" }
]
```

```json
// packages/runtime-graph/tsconfig.json (actuel)
// (zéro references)
```

**Impact** : nouveau contributeur qui fait `install.sh --dev` voit le
build planter et ne sait pas si c'est un bug toolkit ou son env. Le 2e
run cache le bug.

**Fix proposé** :

```json
// packages/codegraph/tsconfig.json
"references": [
  { "path": "../salsa" },
  { "path": "../datalog" }
]
// packages/runtime-graph/tsconfig.json
"references": [
  { "path": "../datalog" },
  { "path": "../salsa" }
]
```

Reproduit fiablement avec `npm run clean && npm run build`.

### F-102 · `datalog-check` ne découvre pas le package npm `invariants-postgres-ts`

**Symptôme** : après `npm install @liby-tools/invariants-postgres-ts`,
`npx codegraph datalog-check` échoue :

```
✗ datalog-check failed: Error: ENOENT: no such file or directory,
  scandir '/Users/smurfy/dpl/dpl-rag/invariants'
```

L'utilisateur doit deviner :

```bash
npx codegraph datalog-check \
  --rules-dir node_modules/@liby-tools/invariants-postgres-ts/invariants
```

**Cause racine** : `packages/codegraph/src/cli/commands/datalog-check.ts:38-41`
hardcode 2 paths candidats :

```ts
const rulesDir = opts.rulesDir ?? (
  await exists(path.join(root, 'sentinel-core/invariants'))
    ? path.join(root, 'sentinel-core/invariants')
    : path.join(root, 'invariants')
)
```

Aucune logique pour résoudre `@liby-tools/invariants-postgres-ts/invariants`
depuis `node_modules`. Le multi-dir loader v0.5.0 (`runFromDirs(rulesDir: string[])`)
existe mais n'est pas exploité par défaut côté CLI.

**Impact** : le quickstart README

```bash
npm install --save-dev @liby-tools/codegraph @liby-tools/invariants-postgres-ts
npx codegraph analyze
npx codegraph datalog-check
```

ne marche pas out-of-the-box. Friction critique au premier run.

**Fix proposé** : faire fallback vers le package npm via `createRequire` :

```ts
const fallbackCandidates = [
  path.join(root, 'sentinel-core/invariants'),
  path.join(root, 'invariants'),
  // NEW: auto-discover canonical invariants
  await tryResolveCanonicalInvariants(root),
].filter(Boolean)

async function tryResolveCanonicalInvariants(root: string): Promise<string | null> {
  try {
    const require = createRequire(path.join(root, 'package.json'))
    const pkgJson = require.resolve('@liby-tools/invariants-postgres-ts/package.json')
    return path.join(path.dirname(pkgJson), 'invariants')
  } catch { return null }
}
```

Le multi-dir loader (`runFromDirs(rulesDir: string[])`) permet ensuite
de combiner canonical + projet local sans duplication, conformément au
pattern documenté dans le README v0.5.0.

### F-103 · Rule `composite-orphan-file` diverge du détecteur CLI orphans

**Symptôme** : sur dpl-rag, `npx codegraph orphans` rapporte 0 orphans
(health 100%, fix F-001 actif). MAIS `npx codegraph datalog-check` lève
14 violations `COMPOSITE-ORPHAN-FILE` :

```
COMPOSITE-ORPHAN-FILE components/chat/ErrorBanner.test.tsx
COMPOSITE-ORPHAN-FILE components/chat/FeedbackButtons.test.tsx
COMPOSITE-ORPHAN-FILE components/chat/Sources.test.tsx
COMPOSITE-ORPHAN-FILE components/chat/Suggestions.test.tsx
COMPOSITE-ORPHAN-FILE instrumentation-client.ts
COMPOSITE-ORPHAN-FILE instrumentation.ts
COMPOSITE-ORPHAN-FILE next.config.ts
COMPOSITE-ORPHAN-FILE playwright.config.ts
COMPOSITE-ORPHAN-FILE proxy.ts
COMPOSITE-ORPHAN-FILE scripts/ingest.ts
COMPOSITE-ORPHAN-FILE scripts/openclaw-fill.ts
COMPOSITE-ORPHAN-FILE vercel.ts
COMPOSITE-ORPHAN-FILE vitest.config.ts
COMPOSITE-ORPHAN-FILE vitest.setup.ts
```

14/14 sont des faux positifs Next.js (instrumentation, proxy, configs,
test files, scripts, vercel.ts, vitest setup) — exactement ceux que
F-001 / F-009 ont résolu côté détecteur CLI.

**Cause racine** : `composite-orphan-file.dl:29-30` ne reconnaît qu'un
seul tag pour les fichiers framework-routed :

```dl
.decl IsFrameworkRouted(file: symbol)
IsFrameworkRouted(F) :- FileTag(F, "page").
```

Mais le CLI `orphans` utilise `core/framework-conventions.ts` qui couvre
au moins :
- Next.js : `page`, `layout`, `route`, `error`, `loading`, `not-found`,
  `template`, `default`, `head`, `icon`, `apple-icon`,
  `opengraph-image`, `twitter-image`, `sitemap`, `robots`, `manifest`,
  `proxy` (Next.js 16), `instrumentation`, `instrumentation-client`,
  `middleware`
- Sentry : `sentry.{client,server,edge}.config.ts`
- Configs implicites : `next.config`, `vitest.config`, `vitest.setup`,
  `playwright.config`, `vercel.ts`, `eslint.config`, etc.
- Tests / scripts : `*.test.{ts,tsx}`, `scripts/*`, `bin/*`

**Impact** : dès qu'un projet active `datalog-check`, il pète avec 14+
faux positifs sur des fichiers que le CLI considère pourtant légitimes.
Source unique de vérité brisée.

**Fix proposé** : étendre les facts émis pour couvrir tous les patterns
de `core/framework-conventions.ts` (par exemple `FileTag(F, "framework-routed")`
ou `FrameworkRoutedFile(F)`), puis aligner la rule :

```dl
IsFrameworkRouted(F) :- FrameworkRoutedFile(F).
```

Alternative moins risquée : ajouter un fact `IsImplicitEntryPoint(F)`
émis par le même module que `core/framework-conventions.ts`, et la rule
fait :

```dl
Violation("COMPOSITE-ORPHAN-FILE", F, 0, "...") :-
    File(F),
    !ImportedFile(F),
    !IsEntryPoint(F),
    !IsImplicitEntryPoint(F),  // NEW
    !IsPackageEntryPoint(F),
    !IsFrameworkRouted(F),
    !IsTestFixture(F),
    !OrphanFileGrandfathered(F).
```

### F-104 · `composite-tainted-var-to-sink` ne reprend pas le filtre F-011 (process.env)

**Symptôme** : sur dpl-rag, 2 violations `COMPOSITE-TAINTED-VAR-TO-SINK` :

```
app/api/github-release-discord/route.ts:46
app/api/sentry-discord/route.ts:26
```

Pattern flagué (identique au F-011 résolu sur cwe-918) :

```ts
const webhookUrl = process.env.GITHUB_RELEASES_DISCORD_WEBHOOK_URL;
// ...
const res = await fetch(webhookUrl, { ... });
```

`webhookUrl` est admin-controlled (env var ops), pas user input.

**Cause racine** : `cwe-918-ssrf.dl` a bien le filtre F-011 :

```dl
TaintedArgCall(File, Line, _, "fetch", _, Source, _),
Source != "process.env",
TaintSink(File, Line, "http-out", _, _),
```

Mais `composite-tainted-var-to-sink.dl:24-28` ignore complètement le
filtre `Source` :

```dl
Violation("COMPOSITE-TAINTED-VAR-TO-SINK", File, Line, "...") :-
    TaintedArgCall(File, Line, _, _, _, _, _),
    TaintSink(File, Line, _, _, _),
    !TaintedVarToSinkGrandfathered(File, Line).
```

La grandfather list (`TaintedVarToSinkGrandfathered`) est par-fichier
ligne-à-ligne (Sentinel a 1 entrée pour `server.ts:64`). Pas de fix
systémique.

**Impact** : tout projet qui utilise des env vars de config (webhooks,
DB URLs, API keys côté serveur) en passage direct à un sink se mange
des faux positifs. Pattern ultra-courant.

**Fix proposé** : reprendre le filtre F-011 dans la rule composite :

```dl
Violation("COMPOSITE-TAINTED-VAR-TO-SINK", File, Line, "...") :-
    TaintedArgCall(File, Line, _, _, _, Source, _),
    Source != "process.env",
    TaintSink(File, Line, _, _, _),
    !TaintedVarToSinkGrandfathered(File, Line).
```

Ou, plus propre, factoriser via un fact `TrustedSource(s)` partagé entre
les rules taint :

```dl
.decl TrustedSource(s: symbol)
TrustedSource("process.env").
TrustedSource("import.meta.env").
TrustedSource("constants").
```

Et toutes les rules taint qui veulent l'utiliser font `!TrustedSource(Source)`.

### F-105 · `@liby-tools/invariants-postgres-ts` pas publié sur npm registry

**Symptôme** : `npm view @liby-tools/invariants-postgres-ts version` →
`E404 Not Found`. Le README quickstart demande pourtant cette dépendance
en première ligne :

```bash
npm install --save-dev @liby-tools/codegraph @liby-tools/adr-toolkit \
                       @liby-tools/datalog @liby-tools/salsa \
                       @liby-tools/invariants-postgres-ts \
                       @liby-tools/runtime-graph
```

Le table d'inventaire des packages note `published` à côté du package,
mais il n'est pas sur le registre.

**Impact** : impossible de suivre le README out-of-the-box. Sans
`invariants-postgres-ts`, `datalog-check` est inutilisable (pas de rules
canoniques). Le toolkit est de facto en mode incomplet pour tout user
externe.

**Workaround utilisé pour ce dogfood** : `npm pack` du worktree local
+ install via `file:` path. Marche, mais pas raisonnable comme onboarding.

**Fix proposé** : publier le package. Le tarball
`packages/invariants-postgres-ts/liby-tools-invariants-postgres-ts-0.1.0.tgz`
existe déjà localement (untracked sur la branch courante du toolkit
au moment de l'audit), donc le packaging fonctionne.

À vérifier avant publish : la doc README du package mentionne que les
rules consomment des facts émis par codegraph — préciser la version
minimale de `@liby-tools/codegraph` requise (peer-dep) pour éviter la
récidive de F-004.

### F-106 · Premier run sans baseline = 13 articulation points + 7 hot-allocations + 12 await-in-loop = 63 violations

**Symptôme** : `npx codegraph datalog-check` au premier run sur dpl-rag
(0 baseline) :

```
total: 63, baseline: 0, new: 63
```

Dont :
- 13× `NO-NEW-ARTICULATION-POINT` (22% des fichiers)
- 12× `COMPOSITE-AWAIT-IN-LOOP` (légitime sur `lib/refresh.ts`,
  `app/workflows/ingest.ts`, scripts ingestion — par design séquentiel
  pour rate-limiting / order)
- 7× `COMPOSITE-HOT-ALLOCATION` (allocations dans hot path = workflow
  d'ingest qui process des PDFs en série)
- 14× `COMPOSITE-ORPHAN-FILE` (cf. F-103)

Le pattern ratchet du toolkit suppose que le premier run produit une
baseline qui "freeze" l'existant comme dette grandfathered. Mais le
README quickstart ne mentionne pas l'étape `--update-baseline` au
premier run.

**Impact** : utilisateur première session voit 63 violations dont la
majorité sont (a) du legitime by-design ou (b) des FP des rules
composites. Verdict émotionnel : "le toolkit est bruyant" → bail.

**Fix proposé** :
1. README quickstart : ajouter step explicite après `analyze` :
   ```bash
   # 1er run : freeze l'existant comme baseline
   npx codegraph datalog-check --update-baseline
   # runs suivants : ne montre que les régressions
   npx codegraph datalog-check --diff
   ```
2. Optionnel : faire que `datalog-check` sur un repo sans baseline
   suggère le `--update-baseline` au lieu de cracher 63 lignes.

---

## 💡 Suggestions

### F-107 · Auto-discover invariants depuis tous les `@liby-tools/invariants-*` installés

Une fois F-102 résolu pour `invariants-postgres-ts`, généraliser : si
un projet installe `@liby-tools/invariants-react-ts`,
`@liby-tools/invariants-graphql`, etc., le runner devrait composer
automatiquement les rules de tous les packages présents dans
`node_modules/@liby-tools/invariants-*`.

### F-108 · `codegraph-toolkit init --stack nextjs-supabase` (alignée F-010)

Le `codegraph.config.json` que dpl-rag aurait besoin pour bien marcher
hors entrypoints (par exemple `detectorOptions.taint.enabled`,
`scriptEntryPoints`, `testEntryPoints` cosmétiques) ressemble à ce que
Happenin a déjà. Une commande `init --stack nextjs-supabase` qui génère
un config idiomatique éviterait les itérations.

### F-109 · `--rules-dir auto` flag

En attendant F-102, exposer `--rules-dir auto` qui résout via
`createRequire('@liby-tools/invariants-postgres-ts/package.json')`.
Workaround documenté dans le README quickstart, retire la friction ENOENT.

---

## Stats globales

Sur dpl-rag (master ee3a58d, 2026-05-08) :

| Métrique | npm 0.6.0 | master post-batch3 |
|---|---|---|
| Files | 59 | 59 |
| Health code | 54 % | **100 %** |
| Orphans CLI | 27 / 59 | **0 / 59** |
| Build cold | OK (npm install) | **❌ tsc fail** (F-101) |
| `datalog-check` out-of-the-box | crash ENOENT | crash ENOENT (F-102) |
| `datalog-check` avec `--rules-dir` explicit | n/a | 63 violations (F-103/F-104/F-106) |
| Vraies violations actionables après filtres | n/a | ~10 (cycles, cognitive bombs, await-loops sur hot path) |

Les ~10 vraies violations actionables :
- 1× `CYCLES` `lib/retrieval.ts` ↔ `lib/stub-data.ts` (cycle réel,
  fallback stub-data importe retrieval pour shape parity)
- 3× `COMPOSITE-COGNITIVE-BOMB` / `CYCLOMATIC-BOMB` sur
  `lib/conversations.ts:39` et `scripts/test-rag.ts:43,171` (vrais
  hotspots refactor)
- 1× `COMPOSITE-DEP-UNUSED` package.json
- 4× `COMPOSITE-ENV-VAR-SPREAD` (CI, EVAL_BYPASS_TOKEN, INGEST_TOKEN,
  NEXT_PUBLIC_SENTRY_DSN — chacune lue dans 3+ sites, pattern ADR-019
  applicable)
- 1× `NO-BOOLEAN-POSITIONAL-PARAM` `scripts/test-rag.ts:256`

Avec F-103/F-104/F-106 résolus, le ratio bruit/signal passerait de ~85 %
à ~15 %. C'est ce qui fait la différence entre un toolkit qu'on garde
et qu'on désinstalle après 2 jours.

---

## Notes

Doc rédigée en session de dogfooding du 2026-05-08, après lecture du
DOGFOODING-HAPPENIN.md pour aligner le format. Le worktree d'audit a
été créé à `/tmp/codegraph-audit-dpl-rag` à partir de `master ee3a58d`
pour ne pas perturber la branche `feat/audit-batch4-p2-monorepo` en
cours sur le repo principal.

Bouge librement les sections, supprime ce qui est traité, ajoute ce
que tu vois sur d'autres projets.
