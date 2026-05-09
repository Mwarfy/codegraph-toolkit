# Re-audit external — 4 projets (2026-05-09)

> 3eme audit (apres OSS-AUDIT-2026-05-08 + 4 projets internes du
> 2026-05-08). Lance avec codegraph 0.6.1 (post merges PR #6→#22).
> Focus : identifier ce qui reste actionnable apres tous les batchs.

## Stats globales

| Projet | Files | Edges | Orph | Health | Datalog viol. | Tensions |
|--------|------:|------:|----:|-------:|------------:|--------:|
| **happenin** (Next.js 16 + Expo + Supabase) | 704 | 1384 | **0** | **100%** | 824 | 11 |
| **openclaw-mcp** (MCP server) | 45 | 117 | 1 | 97% | 40 | 1 |
| **dpl-rag** (Next.js 16 + Vercel AI) | 59 | 54 | **0** | **100%** | 48 | 7 |
| **janus** (Next.js 16 + Strava) | 58 | 122 | 2 | 95% | 19 | 7 |

Etat **excellent** sur la classification orphan + health. Le bruit
restant vient du **Datalog rules** : 824 violations sur happenin,
40 sur openclaw-mcp, 48 sur dpl-rag, 19 sur janus.

---

## P0 — bruit systemique des rules sans baseline

### F-201 — `NO-NEW-ARTICULATION-POINT` reporte tous les cut-vertex sans baseline

**Severite** : haute (192 violations cumulees sur les 4 projets — 23% du total)

**Symptome** : la rule flag tous les fichiers qui sont des "cut-vertex"
du graphe d'imports comme s'ils etaient **nouvellement** introduits.

Sample janus :
```
lib/env.ts, lib/utils.ts, lib/supabase/server.ts, lib/strava/encryption.ts,
components/ui/alert.tsx, components/ui/card.tsx, components/coming-soon.tsx,
app/(auth)/login/login-form.tsx, lib/garmin/sync.ts, lib/supabase/proxy.ts
```

Tous ces fichiers existent **depuis le debut** du projet. Ils sont tous
flagges comme "nouveaux articulation points".

**Cause** : la rule est concue pour le mode `--diff` avec un baseline.
Sans baseline (premier run, ou hors mode CI), TOUS les cut-vertex
existants apparaissent comme "nouveaux".

**Pistes de fix** :

1. **Auto-grandfather sur premier run** : si aucun baseline n'existe,
   la rule traite l'etat courant comme baseline implicit (skip toutes
   les violations) avec un warning "Run `--update-baseline` to
   establish a baseline".
2. **Restreindre au mode `--diff`** : seul `datalog-check --diff`
   declenche cette rule. Sinon skip.
3. **Documenter dans le README** : "ces rules sont conques pour `--diff`,
   sinon bruit systemique sur projets matures".

Impact estime : -23% des violations cumulees (-192 violations).

### F-202 — `COMPOSITE-MISPLACED-FILE` bruit massif sur layouts OSS

**Severite** : moyenne-haute (247 violations sur happenin, 30% du total)

**Symptome** : Newman-Girvan modularity classifie les fichiers
naturellement isoles (e2e/, sentry.*.config.ts, mobile/, scripts/)
comme "dans la mauvaise community".

Sample happenin :
```
e2e/auth-signup-login.spec.ts (community != 'app/')
e2e/authenticated-flows.spec.ts (community != 'app/')
sentry.edge.config.ts (community != 'src/lib/')
sentry.server.config.ts (community != 'src/lib/')
mobile/app/_layout.tsx (community != 'src/app/')
```

**Cause** : ces fichiers sont **par design** dans des communities
disjointes (e2e tests, configs Sentry implicit-loaded, sub-app Expo
mobile). Le detecteur ne les exempte pas.

**Pistes de fix** :

1. **Skip les patterns OSS layout** dans la rule : si `file` matche
   `isOssLayoutEntryPoint()` (deja dans framework-conventions.ts,
   PR #8), skip.
2. **Skip les sentry.*.config.ts / vitest.config.ts / proxy.ts /
   middleware.ts / instrumentation*.ts** : meme path que P1.
3. **Skip les sub-app Expo** : `mobile/app/**` est un sous-repertoire
   Expo Router avec sa propre community attendue.

Impact estime : -247 violations sur happenin (-30%), application
similaire sur les autres projets.

### F-203 — `COMPOSITE-BAYESIAN-DRIVER` bruit sur configs co-evoluees

**Severite** : moyenne (53 violations happenin)

**Symptome** : la rule detecte un couplage causal Bayesien >=80%
(P(B|A) >= 0.8) entre fichiers qui git-co-changent. Mais les configs
qui sont rebase ensemble (`sentry.client.config.ts`, `sentry.server.
config.ts`, `sentry.edge.config.ts`) ont une co-change probability
quasi-1 — flag systematique.

Sample :
```
sentry.edge.config.ts → sentry.server.config.ts (P >= 0.8)
sentry.server.config.ts → sentry.client.config.ts (P >= 0.8)
```

**Pistes de fix** :

1. **Whitelist les triple-configs Sentry** : matcher si les 3 fichiers
   sont dans le set `sentry.{client,server,edge}.config.ts` → skip.
2. **Skip les configs en general** via `isToolConfigFile` (PR #8).
3. **Augmenter le seuil** pour ces patterns connus a co-evoluer (0.95 ?).

Impact estime : -30 violations happenin.

---

## P1 — DEP-UNUSED faux positifs systemiques (continuation F-005)

### F-204 — Whitelist build-time etendue (CSS / PostCSS / vitest plugins)

**Severite** : haute (cumul 16+7+6 = 29 violations DEP-UNUSED sur 3 projets)

PR #12 a deja whitelist :
- typescript, eslint, prettier, vitest, jest, biome
- bundlers (tsup, tsx, rollup, vite, etc.)
- prefixes @types/, eslint-config-, eslint-plugin-, @typescript-eslint/
- packages avec `bin` field auto-detectes (PR #12 F-005)

**Manquent** (dogfood :

| Pattern | Origine | Exemples |
|---------|---------|----------|
| `tailwindcss`, `@tailwindcss/postcss`, `tw-animate-css` | PostCSS plugins charges via `postcss.config.{js,mjs}` | janus, dpl-rag |
| `autoprefixer`, `postcss-*` | PostCSS chain | (commun) |
| `@vitest/coverage-v8`, `@vitest/ui`, `jsdom`, `happy-dom` | Vitest environment + plugins | dpl-rag |
| `@workflow/*` (workflow, ai, next) | Vercel Workflow runtime | dpl-rag |
| `expo-*`, `@expo/*`, `react-native-*`, `@react-native-*/*` | Expo Router / RN runtime auto-load | happenin |
| `react-dom`, `react`, `next` | Next.js implicit (jamais explicite import par app code) | janus, happenin |

**Pistes de fix** : etendre `BUILD_TIME_DEPS_LITERAL` + `BUILD_TIME_DEPS_PREFIX`
dans `extractors/package-deps.ts`.

Impact estime : -25 violations DEP-UNUSED cumulees.

### F-205 — Peer deps cross-workspace internal

**Severite** : moyenne (3 violations janus)

**Symptome** : sur janus, le projet declare `@liby-tools/invariants-
postgres-ts` et `@liby-tools/salsa` comme deps directes. Ces packages
sont des **peer deps** d'autres `@liby-tools/*` que l'app utilise.
Le scan static ne les voit pas → flag DEP-UNUSED.

Mais ils SONT necessaires (sans eux, npm ERESOLVE).

**Pistes de fix** :

1. **Detecter les peer deps d'autres deps** : si `@liby-tools/X` est
   dans `dependencies` ET dans le `peerDependencies` d'un autre
   `@liby-tools/Y` qui est utilise → exempter.
2. **Whitelist `@liby-tools/*` prefix** : narrow-scope mais simple.
3. **Auto-detection scope monorepo external** : si `node_modules/@scope/`
   contient plusieurs packages dont les peers se chevauchent, exempter.

Impact estime : -3 violations janus, application similaire sur d'autres
toolkits scope-based.

---

## P2 — vrais positifs interessants a remonter

### F-206 — Cycle reel `dpl-rag` `lib/retrieval.ts ↔ lib/stub-data.ts`

**Vrai positif**. Le toolkit le detecte correctement, fournit le
`testHint: 'inverser l'import OU extraire dans un 3e fichier'`. Ne
necessite pas de fix du toolkit, c'est de l'info actionnable pour le
user.

### F-207 — Composants shadcn/ui non utilises (janus)

**Vrai positif**. `components/ui/separator.tsx` et `components/ui/sonner.tsx`
sont generees par `npx shadcn add` mais jamais importees. User peut :
- les supprimer (recommande)
- ou ajouter une convention de skip pour `components/ui/` (mais
  contre-recommande — masque les vrais positifs)

Pas un fix toolkit.

### F-208 — `RequestStatus#accepted`, `MobileSheetState#peek/half/full` (happenin)

**A investiguer** : la rule FSM marque ces etats comme `fsm-orphan`
(declares mais jamais ecrits). Ces sont probablement des valeurs enum
passees en props/args (`<Sheet position="peek" />`) plutot qu'assignes
a une variable.

**Piste de fix** : etendre la detection FSM-write pour inclure :
- JSX prop assignment : `<C state="peek" />`
- Function arg literal : `setStatus("peek")`
- Object property assignment : `{ status: "peek" }`

Si c'est deja le cas, alors c'est probablement vrai positif (etats jamais
utilises) — info actionnable pour le user.

---

## P3 — perf observation (positif)

happenin (704 files) analyze en ~24s en mode legacy (post P4 mutualization).
Pour comparaison : pre-P4 c'etait ~43s sur tanstack-query (863 files).
Ratio ~equivalent : la mutualization marche.

`datalog-check` complet sur happenin : 824 violations en ~700ms (parsing
Datalog + evaluation). Tres bien.

---

## Plan d'attaque suggere

Trie par ratio impact / effort :

| # | Item | Effort | Reduction violations | Bloque qui |
|---|------|:------:|--------------------:|------------|
| 1 | F-204 — whitelist build-time CSS/PostCSS/vitest/expo/RN/workflow/react-dom | 30 min | -25 (dep-unused) | tous |
| 2 | F-201 — auto-grandfather articulation-point si pas baseline | 1-2h | -192 (toutes projets) | tous projets matures |
| 3 | F-202 — skip OSS layout dans MISPLACED-FILE | 30 min | -247 (happenin) | gros projets |
| 4 | F-203 — skip configs co-evoluees dans BAYESIAN-DRIVER | 30 min | -30 (happenin) | projets Sentry triple |
| 5 | F-205 — peer dep cross-workspace detection | 2-3h | -3 (janus) | toolkits scope-based |
| 6 | F-208 — FSM-write detection JSX/args | 2-3h | (info qualite) | projets React+FSM |

**Quick wins groupables en 1 PR (~1.5h)** : F-204 + F-203 + F-202 +
F-201 (light : skip si pas de baseline). Resout 80% du bruit observe.

**Vague suivante** : F-205 + F-208 (refactor leger, plus delicate).

---

## Comparaison avec audit precedent (2026-05-08)

| Metrique | Audit v2 | Audit v3 | Δ |
|----------|---------:|---------:|--:|
| happenin orphans | 0 | 0 | = |
| happenin health | 100% | 100% | = |
| openclaw-mcp orphans | 8 (clone shallow) | 1 | -7 |
| openclaw-mcp health | 81% | 97% | +16% |
| dpl-rag orphans | 11 | 0 | -11 |
| dpl-rag health | 73% | 100% | +27% |
| janus orphans | 2 | 2 | = |
| janus health | 94% | 95% | +1% |

Les findings F-101 a F-110 (dpl-rag dogfood batch) ont apporte un saut
qualite massif sur dpl-rag (orphans 11 → 0, health 73% → 100%).

**Marge restante** : presque uniquement sur le bruit Datalog rules,
pas sur la classification orphan/entry-point qui est quasi-parfaite.

Tous les findings F-001 a F-110 (Janus + Happenin + DPL-RAG dogfoods,
OSS-AUDIT P0-P4, batchs P1-P5) sont resolus cote code. **Action
publication restante** : voir `docs/RELEASE-PLAN.md`.
