# Dogfooding sur dpl-rag — re-audit 2026-05-09 (master 6b40eb9)

Re-run du dogfooding sur [dpl-rag](https://github.com/digital-pharma-lab/rag-dpl)
24h après le merge de [PR #9](https://github.com/Mwarfy/codegraph-toolkit/pull/9).
Master a avancé de 8 PRs entre temps (#10–#19) — l'objectif est de mesurer ce
qui s'est amélioré, ce qui reste cassé, et ce que les nouvelles features
révèlent.

Stack inchangée : Next.js 16 App Router + Supabase pgvector + AI Gateway +
Sentry + Workflow, 59 fichiers TS, 3 webhook proxies, deploy Vercel.

## TL;DR — état des findings F-101 à F-106 (re-vérifié aujourd'hui)

| ID | Sujet | État | Notes |
|---|---|---|---|
| F-101 | Cold `tsc -b` fail | ❌ **toujours cassé** | Reproduit sur `npm run clean && npm run build` |
| F-102 | `datalog-check` ENOENT | ❌ **toujours cassé** | Logic `datalog-check.ts:55-59` inchangée |
| F-103 | `composite-orphan-file` divergence | ❌ **toujours cassé** | 14 FP Next.js sur dpl-rag aujourd'hui |
| F-104 | filtre `process.env` manquant | ❌ **toujours cassé** | 2 FP confirmés sur les routes proxy |
| F-105 | `invariants-postgres-ts` pas sur npm | 🟡 **plan en place** | `docs/RELEASE-PLAN.md` identifie comme P0 — awaiting `npm publish` |
| F-106 | First-run UX (baseline) | 🟡 **partiellement adressé** | README mentionne pattern post-commit, mais pas le quickstart |

Aucun des 4 bugs code (F-101–F-104) n'a été touché par les 8 PRs récentes.
F-105 a un plan documenté mais pas exécuté.

## Ce qui s'est amélioré entre temps (validations)

### Janus F-001 — `datalog-check` TypeError résolu

PR #12 (`dc0129c`) a appliqué le fix `result.outputs` → `result.result.outputs`.
Vérifié sur dpl-rag : `datalog-check` ne crashe plus en TypeError quand on
lui fournit `--rules-dir` (le crash F-102 ENOENT reste mais c'est une autre
issue).

### P0 detector visibility (PR #8/#9, déjà mergé)

Output `analyze` aujourd'hui :

```
54 detectors total ran (graph base + composite/quality/security/etc).
Run `codegraph detectors` for the full list with descriptions.
```

Et `codegraph detectors` liste 54 détecteurs avec timing — utile pour
comprendre ce qui tourne. ✅

### P4 perf — analyzer 24 % plus rapide

Sur dpl-rag (59 fichiers) :

| | PR #9 (ee3a58d) | master 6b40eb9 |
|---|---|---|
| Total analyze | 5.5s (user 7.06s) | **4.17s (user 5.66s)** |

Speedup -24 % wall-clock, -20 % CPU. PR #14 (sharedProject pre-build) tient
sa promesse. ✅

### SARIF 2.1.0 output (PR #16)

`codegraph datalog-check --rules-dir ... --format sarif` produit du SARIF
parsable par GitHub Code Scanning. ✅ (testé : flag accepté, sortie générée).

Note doc : le `--help` mentionne `--format sarif` mais l'erreur sur le flag
court `--sarif` est juste `unknown option` sans suggestion vers `--format
sarif`. Suggestion mineure (cf. F-110).

### DEP-UNUSED granularité (PR #18)

Avant : 1 violation par projet quel que soit le nombre de packages inutilisés.
Après : 1 violation par package (`COMPOSITE-DEP-UNUSED` × 4 sur dpl-rag).
Plus actionable — chaque violation pointe vers un package précis à supprimer.

---

## Findings re-vérifiés aujourd'hui

### F-101 (re-vérifié) · Cold `tsc -b` fail toujours présent

**Repro fresh sur master `6b40eb9`** :

```bash
git worktree add /tmp/codegraph-audit-v2 origin/master
cd /tmp/codegraph-audit-v2
npm install        # OK
npm run clean      # OK
npm run build      # ❌ FAIL
```

Sortie identique à ma PR #9 :

```
packages/codegraph/src/cli/commands/datalog-check.ts(90,34): error TS2307:
  Cannot find module '@liby-tools/datalog' or its corresponding type declarations.
+ 6 cascade errors
```

Le 2e `npm run build` passe (dist partiellement régénéré). Bug masqué tant
que personne ne fait `clean && build` en CI.

`packages/codegraph/tsconfig.json` toujours :
```json
"references": [
  { "path": "../salsa" }
]
```

`packages/runtime-graph/tsconfig.json` toujours sans `references`.

Aucun commit depuis le 2026-05-08T22:00 ne touche ces deux fichiers
(vérifié via `git log master -- packages/codegraph/tsconfig.json packages/runtime-graph/tsconfig.json`).

**Action** : 2-line fix, autonome, peut être appliqué isolément.

### F-102 (re-vérifié) · `datalog-check` ENOENT out-of-the-box

`packages/codegraph/src/cli/commands/datalog-check.ts:55-59` toujours :

```ts
const rulesDir = opts.rulesDir ?? (
  await exists(path.join(root, 'sentinel-core/invariants'))
    ? path.join(root, 'sentinel-core/invariants')
    : path.join(root, 'invariants')
)
```

À noter : Janus F-006 a fixé l'auto-discover pour `cross-check` (PR #12,
`packages/codegraph/src/cli/commands/cross-check.ts` modifié). Le pattern
existe donc déjà dans le toolkit. Il suffirait d'appliquer le même pattern
à `datalog-check.ts`.

```bash
$ npx codegraph datalog-check
✗ datalog-check failed: Error: ENOENT: no such file or directory,
  scandir '/Users/smurfy/dpl/dpl-rag/invariants'
```

### F-103 (re-vérifié) · `composite-orphan-file` divergence

Rule `composite-orphan-file.dl:30` toujours :

```dl
.decl IsFrameworkRouted(file: symbol)
IsFrameworkRouted(F) :- FileTag(F, "page").
```

Re-run sur dpl-rag aujourd'hui : 14 violations `COMPOSITE-ORPHAN-FILE`,
toutes 14 = FP Next.js (instrumentation, proxy, configs, tests, scripts,
vercel.ts, vitest setup). Identique à PR #9.

Le détecteur CLI `orphans` rapporte 0/59 (health 100%). Divergence intacte.

### F-104 (re-vérifié) · filtre `process.env` toujours absent dans composite-tainted-var-to-sink

`composite-tainted-var-to-sink.dl:24-28` toujours :

```dl
Violation("COMPOSITE-TAINTED-VAR-TO-SINK", File, Line, "...") :-
    TaintedArgCall(File, Line, _, _, _, _, _),
    TaintSink(File, Line, _, _, _),
    !TaintedVarToSinkGrandfathered(File, Line).
```

Le filtre `Source != "process.env"` que `cwe-918-ssrf.dl` applique (fix
F-011 Happenin) n'a pas été propagé.

2 violations FP sur dpl-rag :
- `app/api/github-release-discord/route.ts:46` — `fetch(process.env.GITHUB_RELEASES_DISCORD_WEBHOOK_URL)`
- `app/api/sentry-discord/route.ts:26` — `fetch(process.env.SENTRY_DISCORD_WEBHOOK_URL)`

### F-105 (statut) · invariants-postgres-ts pas encore publié

Bonne nouvelle : `docs/RELEASE-PLAN.md` (créé par PR #19) identifie
la publication comme **P0** :

```
| @liby-tools/invariants-postgres-ts | 0.1.0 | (404) | npm publish première publication | P0 |
```

Versions bumpées (PR #17 `chore(release)`). Tarball local existe
(`packages/invariants-postgres-ts/liby-tools-invariants-postgres-ts-0.1.0.tgz`).
Il manque juste le `npm publish`.

Tant que ce n'est pas publié, le quickstart README reste impossible à
suivre out-of-the-box. C'est le blocker #1 pour les nouveaux users.

### F-106 (statut) · README mentionne le pattern, mais pas dans le quickstart

Le README explique le pattern post-commit (regen baseline), et
`update-baseline` existe en flag. Mais la section quickstart en haut du
README ne mentionne pas que :
1. Premier run produit ~60+ violations même sur projet sain (architecture
   sans dette mais sans baseline).
2. Il faut faire `datalog-check --update-baseline` une fois pour freeze
   l'existant comme dette grandfathered.

Sur dpl-rag aujourd'hui, premier run = 66 violations (vs 63 hier — la
nouvelle granularité DEP-UNUSED ajoute 3 violations). Sans la mention
`--update-baseline` dans le quickstart, l'effet "toolkit bruyant"
demeure.

**Suggestion mini-fix** : 3 lignes dans le quickstart README :

```markdown
# 1er run : freeze l'existant comme baseline historique
npx codegraph datalog-check --rules-dir node_modules/@liby-tools/invariants-postgres-ts/invariants --update-baseline

# Runs suivants (CI / pre-commit) : ne montre que les régressions
npx codegraph datalog-check --rules-dir node_modules/@liby-tools/invariants-postgres-ts/invariants --diff
```

---

## Nouveau finding révélé par les features récentes

### F-110 (nouveau, mineur) · `--sarif` non reconnu, suggestion absente

`commander` accepte `--format sarif` mais pas `--sarif` (flag court qu'un
user testerait par réflexe). L'erreur est sèche :

```
$ npx codegraph datalog-check --sarif
error: unknown option '--sarif'
```

Pas de "did you mean --format sarif". Friction mineure.

**Fix** : alias `commander.option('--sarif', '...')` qui set `format = 'sarif'`,
ou amélioration message d'erreur. Optionnel.

---

## Stats agrégées — dpl-rag re-audit 2026-05-09

| Métrique | PR #9 (2026-05-08) | Re-audit (2026-05-09) | Delta |
|---|---|---|---|
| Total violations datalog | 63 | 66 | +3 (granularité DEP-UNUSED) |
| Health CLI orphans | 100 % | 100 % | = |
| Cold build | ❌ | ❌ | = (F-101) |
| `datalog-check` out-of-the-box | ENOENT | ENOENT | = (F-102) |
| Wall-clock analyze | 5.5s | 4.17s | **-24 %** ✅ |
| FP Next.js orphans | 14 | 14 | = (F-103) |
| FP env-var taint | 2 | 2 | = (F-104) |

Les 4 fixes que ma PR #9 a documentés sont autonomes, factorables, et chacun
prend 1-3 lignes. Total estimé : 1 PR de ~15 lignes pour clore F-101+F-102+F-103+F-104.

Plus la publication npm (F-105) qui est un `npm login` + `npm publish` × 4.

---

## Notes méthodo

- Worktree d'audit créé à `/tmp/codegraph-audit-v2` depuis `origin/master 6b40eb9`.
- Worktree isolée — branche `feat/audit-batch4-p2-monorepo` du repo principal
  et son fichier `FINDINGS-JANUS.md` n'ont pas été touchés.
- Cross-référence Janus : ce doc complète `FINDINGS-JANUS.md` sur les axes
  *non-Supabase-SQL* (dpl-rag a Supabase JS client mais pas de raw migrations
  dans `supabase/migrations/`, donc les rules SQL ne déclenchent pas).
- Bouge librement, supprime ce qui est traité.
