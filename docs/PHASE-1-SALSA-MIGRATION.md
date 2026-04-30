# Phase 1 — Salsa migration plan

> **Pour Claude qui reprend dans une nouvelle session :** lis CE FICHIER EN
> ENTIER avant toute action. Il contient l'état exact, les décisions prises,
> les pièges rencontrés, et le plan pas-à-pas des Sprints 2-4.
>
> Ne fais PAS de discovery — tout est ici. Vérifie juste que les commits
> mentionnés existent encore avec `git log --oneline | head -20` côté
> codegraph-toolkit ET côté Sentinel.

## Contexte global

Sentinel (le projet) consomme `@liby/codegraph` + `@liby/adr-toolkit` +
`@liby/datalog` + `@liby/salsa` (tous dans `~/Documents/codegraph-toolkit/`)
via npm-link manuels (`node_modules/@liby/<pkg>` → symlinks).

Le pipeline d'analyse codegraph tourne aujourd'hui en mode **batch** :
chaque `analyze()` reparcourt tous les fichiers + run tous les détecteurs.
14s en full, 7s en `factsOnly` (mode introduit en M8 — skip detectors lourds).

But Phase 1 : passer en **incremental** via @liby/salsa. Sur changement
d'1 fichier, seul ce qui dépend de ce fichier recompute. Cible : <1s par
commit incrémental.

## État à reprise (après Sprint 6 — cible <500ms warm ATTEINTE)

### Commits livrés sur cette chaîne (codegraph-toolkit)

```
5254819 perf(codegraph): ts-imports reuses sharedProject in incremental mode [Sprint 6]
7815a4d feat(codegraph): expose --incremental flag in CLI [Sprint 4]
4dfd6cc docs(phase-1): refresh boot brief post-Sprint 5
f3af3cb perf(codegraph): warm path optimizations — mtime-aware + Project reuse + skip-set [Sprint 5]
e875f5e docs(phase-1): refresh boot brief post-Sprint 3
b6c2bb6 feat(codegraph): incremental mode — batch 4 final (symbol-refs, taint, metrics) [Sprint 3]
cb6309d feat(codegraph): incremental mode — batch 3 (typed-calls, cycles, data-flows) [Sprint 3]
4756b92 feat(codegraph): incremental mode — batch 2 (complexity, state-machines, truth-points) [Sprint 3]
92eabe3 feat(codegraph): incremental mode — batch 1 (event-emit-sites, package-deps, barrels) [Sprint 3]
ca6d610 feat(codegraph): incremental mode — env-usage + oauth-scope-literals via Salsa (Sprint 2)
84c8287 fix(salsa): add Database.resetState() — preserve registry across reset
5d90920 feat(salsa): @liby/salsa runtime — Salsa-style incremental computation (Sprint 1)
```

### Commits livrés sur Sentinel

```
47aec6e chore(pre-commit): refresh datalog facts before invariants (M8)
195e264 feat(invariants): ADR-014 oauth scopes migré vers Datalog (M7)
c26db3c refactor(adr-019): migrer 50 sites parseInt(process.env) → envInt/envFloat (M6)
0f615b2 docs(adr): ADR-022 formalise le pattern Datalog + cleanup CLAUDE.md (M5)
ac0790e feat(invariants): ADR-019 migré vers Datalog avec ratchet pattern (M4)
bc26f4f feat(invariants): ADR-017 migré vers Datalog déclaratif (M3)
```

### Ce qui MARCHE déjà (ne pas casser)

- 106/106 tests vitest toolkit (legacy script-style tests vérifiés via tsx)
- 659/659 invariant tests passent côté Sentinel (incl. datalog-invariants)
- Pre-commit hook Sentinel : tsc + invariants + ADR anchors + brief sync (~17s)
- 3 ADRs migrés en Datalog : ADR-014 (oauth scopes), ADR-017 (event types), ADR-019 (thresholds)
- `codegraph analyze` legacy : 15s, 0 violation Datalog
- `codegraph analyze` incremental : opt-in via `AnalyzeOptions.incremental: true`
  → 13/14 détecteurs cachés (tous sauf unused-exports)
- Smoke E2E sur Sentinel : counts identiques cross-mode (60 envs, 8 oauth,
  51 events, 19 pkg, 6 barrels, 71 truthPoints, 3 fsm, 521 sigs, 750 edges,
  1 cycle, 160 dataFlows, 1179 symbolRefs)
- Cold incremental **~9.7s**, warm **~493ms** (vs ~8s avant Sprint 6),
  legacy ~21s. Warm vs legacy : **-98%**.
- ts-imports warm : **108ms** (vs 7400ms avant Sprint 6 → -98.5%).
- CLI cold (process neuf) : ~10.3s. Persistence disque pour cross-process
  reportée Sprint 7+.

### Ce qui est NEUF dans Sprint 6

**ts-imports réutilise le sharedProject** (commit `5254819`) :
  - `extractors/ts-imports.ts` → `scanImportsInSourceFile()` exporté +
    `setTsImportPrebuiltProject(project)` setter neutre.
  - `incremental/ts-imports.ts` → wrapper Salsa `tsImportsOfFile(path)`
    + `allTsImports(label)` (gardé pour usage futur, pas wiré dans
    analyze() actuel).
  - `analyze()` mode incremental : pré-construit le sharedProject
    AVANT la boucle des détecteurs et set le prebuilt sur
    TsImportDetector. Évite le double-parse qui coûtait 7s warm.

Diagnostic clé : ce détecteur dominait le warm (95% du temps). En le
faisant réutiliser le sharedProject déjà construit pour les autres
détecteurs, on passe de 7.4s à 108ms (-98.5%).

**Sprint 4 partiel** (commit `7815a4d`) :
  - CLI `codegraph analyze --incremental` exposé.
  - `factsOnly` / `--regen` conservés tant que cold-via-CLI > factsOnly.

### Ce qui est NEUF dans Sprint 5

**Optimisations warm path** (commit `f3af3cb`) :

5.1 — mtime-aware fileContent (`incremental/queries.ts`) :
  - `mtimeCache` Map<path, mtimeMs> module-level
  - `getCachedMtime` / `setCachedMtime` / `clearMtimeCache` exportés
  - analyze() compare fs.stat avec previous run avant readFile.
    Skip total si identique → ~600 readFile + ~600 input.set
    deviennent ~600 fs.stat.

5.2 — Project ts-morph cache (`incremental/project-cache.ts`) :
  - `getOrBuildSharedProject(rootDir, files, tsConfigPath, prevMtimes,
    fileCache)` réutilise le Project entre runs si rootDir +
    tsConfigPath identiques
  - Files added → addSourceFileAtPath ; removed → removeSourceFile ;
    modifiés → sf.replaceWithText pour invalider l'AST
  - `resetProjectCache()` exporté pour tests / commande --cold
  - createSharedProject() ~3-5s sur Sentinel évité en warm

5.3 — setInputIfChanged (`incremental/queries.ts`) :
  - JSON.stringify la valeur à set, compare avec signature précédente
  - Si identique → skip set → cell garde changedAt → downstream skip
  - Appliqué aux inputs lourds : projectFiles, packageManifests,
    sqlDefaults, graphEdges, typedCalls, taintRules, graphNodes,
    graphEdgesForMetrics
  - Élimine l'invalidation massive des agrégats globaux entre runs

### Ce qui est NEUF dans Sprint 3

**13 détecteurs migrés** sous le pattern uniforme `extractXxxFileBundle`
(per-file) + `buildXxxFromBundles` (pure agrégat) + queries Salsa
`xxxOfFile(path)` + `allXxx(label)`.

Migrés (ordre des batches) :
- Batch 1 (commit `92eabe3`) : event-emit-sites, package-deps, barrels
- Batch 2 (commit `4756b92`) : complexity, state-machines, truth-points
- Batch 3 (commit `cb6309d`) : typed-calls, cycles, data-flows
- Batch 4 (commit `b6c2bb6`) : symbol-refs, taint, module-metrics,
  component-metrics

**Reporté** : unused-exports. Le détecteur est intrinsèquement cross-file
(un export est unused ssi PERSONNE ne l'importe — chaque modif d'import
invalide tout). Pour l'incrémentaliser proprement il faut le découper
en queries fines ("symbol X importé quelque part ?") — refactor à part,
pas un wrap.

### Ce qui est NEUF dans Sprint 2

**@liby/salsa** :
- `Database.resetState()` — clear cells + revision + stats en gardant le
  registry. Indispensable pour les tests qui utilisent des queries
  module-level (sinon `reset()` casse le wake-up).

**@liby/codegraph** :
- `src/incremental/database.ts` — sharedDb singleton process-wide
- `src/incremental/queries.ts` — `fileContent` (input), `projectFiles`
  (input), `setIncrementalContext()` pour passer le ts-morph Project
- `src/incremental/env-usage.ts` — `envUsageOfFile(path)` + `allEnvUsage(label)`
- `src/incremental/oauth-scope-literals.ts` — `oauthScopesOfFile(path)` +
  `allOauthScopeLiterals(label)`
- Refactor `extractors/env-usage.ts` : `scanEnvReadersInSourceFile()` +
  `aggregateEnvReaders()` exportés (réutilisables Salsa).
- Refactor `extractors/oauth-scope-literals.ts` : `scanOauthScopesInContent()`
  exporté.
- `analyze(config, { incremental: true })` route les 2 détecteurs vers
  Salsa, mode legacy entièrement préservé.
- `tests/incremental.test.ts` (7 tests) : parité legacy/incremental,
  cache hit total, invalidation ciblée.

**Pour Sprint 3** : suivre exactement le même pattern (helper per-file +
queries Salsa + tests parité+invalidation). Le Project ts-morph reste
global au moins jusqu'à fin Sprint 3.

## Algorithme Salsa — sémantique subtile (lis-moi)

**3 bugs réels rencontrés en Sprints 1-2**, à ne pas refaire :

### Bug 1 — `hasQuery` regardait le cache

`Database.hasQuery(id)` regardait `cells.has(id)` au lieu d'un registry séparé.
Mais le cache des cells est vide jusqu'à la 1ère écriture, donc deux
`derived(db, 'X', ...)` étaient acceptés silencieusement. **Fix :** registry
séparé `registered: Set<QueryId>` + `registerQuery(id, fn?)`.

### Bug 2 — Deep-verify sans re-lire le cell après wake-up

Dans `allDepsStable`, si une dep derived n'est pas vérifiée à la révision
courante, on doit la "réveiller" (la rappeler récursivement). MAIS après
le wake-up, on doit RE-LIRE le `depCell` du Database — pas comparer le
snapshot d'avant. Sinon le `changedAt` post-wake-up est ignoré et la
cell appelante reste avec sa vieille valeur.

```ts
if (depCell.verifiedAt < cur) {
  const fn = db.getDerivedFn(dep.queryId)
  if (fn) {
    wakeUpDerivedDep(db, dep.queryId, dep.encodedKey, fn)
    const refreshed = db.getCell(dep.queryId, dep.encodedKey)  // ← KEY
    if (!refreshed) return false
    depCell = refreshed                                          // ← KEY
  }
}
if (depCell.changedAt > cell.computedAt) return false
```

### Sémantique red/green qui MARCHE

Quand on `set` un input avec la MÊME valeur (`Object.is`-égale), `changedAt`
ne bouge pas (mais `computedAt` et `verifiedAt` deviennent la nouvelle révision).
Idem dans `executeAndCache` : si nouvelle valeur === ancienne, garde
`changedAt` d'avant. Cela permet aux downstream de skipper :
`dep.changedAt <= cell.computedAt` reste vrai.

Le test qui prouve que ça marche : `tests/invalidation.test.ts > "red/green"
— derived value unchanged → grandchild not recomputed`.

### Bug 3 — `reset()` cassait les queries module-level

`Database.reset()` clear `registered` + `derivedFns`. Mais des wrappers
créés au top-level d'un module (`input(db, 'X')` / `derived(db, 'Y', fn)`)
ne se ré-enregistrent pas — ils existent en module state, pas dans le
registry de la DB. Après `reset()`, `derivedFns` était vide, donc
`allDepsStable()` ne pouvait plus wake-up les deps derived (le
`getDerivedFn(id)` retournait undefined).

**Fix (Sprint 2 commit `84c8287`)** : ajouter `resetState()` qui clear
seulement cells + revision + stats. Le registry est préservé. `reset()`
garde sa sémantique pour les tests qui re-créent leurs queries.

Pour les tests Sprint 2+ : utiliser `sharedDb.resetState()` dans
`beforeEach`, jamais `reset()` (sauf si on re-create explicitement).

### Wake-up isolation

`wakeUpDerivedDep` push une "isolated frame" via `als.run(isolatedFrame, ...)`
pour que `trackParentDep` ne pollue pas la frame appelante. Sinon, la cell
en cours de validation se ferait ajouter ses propres deps deux fois.

### Cycle detection

Set partagé `inFlight` traversal-scoped. Si `(queryId, encodedKey)` y est
déjà à l'entrée d'`executeAndCache`, throw `cycle`.

### Décisions explicites (NE PAS revenir dessus)

- **Sync only.** Pas de Promise dans les queries. AST ts-morph est sync, donc OK.
- **Pas de récursion fixed-point.** Cycle = throw. ADRs Sentinel n'en ont pas besoin.
- **Pas de durabilité levels** comme Salsa-rs. Pas pertinent pour notre usage.
- **Pas de GC de cells stales.** `db.reset()` pour repartir. À <10k cells ce n'est pas un problème.
- **Pas de tuples nested.** `decodeKey` ne sait pas. Si besoin un jour, étendre.

## Sprint 2 — Migrate parseFile + 2 detectors PoC ✅ DONE (commit `ca6d610`)

### Goal (atteint)

Wraper le pipeline ts-morph autour de Salsa pour que `parseFile(path)`
devienne une query. Migrer 2 détecteurs simples (env-usage et
oauth-scope-literals — tous deux ont peu de deps, output stable).

À la fin de Sprint 2 (état actuel) :
- ✅ `analyze()` gagne un mode `incremental: true` qui utilise Salsa
- ✅ Mode legacy (full + factsOnly) reste intact (15s sur Sentinel)
- ✅ Sur 2 reruns consécutifs sans changement → cache hit total
  (0 miss supplémentaire sur `envUsageOfFile` et `oauthScopesOfFile`)
- ✅ 7 tests dédiés démontrant le cache hit + parité legacy

### Étape 1 — Database wiring

Créer `packages/codegraph/src/incremental/database.ts` :
```ts
import { Database } from '@liby/salsa'
export const sharedDb = new Database()  // ou : passé en paramètre à analyze()
```

Ajouter `@liby/salsa` aux deps de `@liby/codegraph` :
```json
"dependencies": {
  "@liby/salsa": "workspace:*",
  ...
}
```

Lancer `npm install --workspace=@liby/codegraph`. Vérifier que le symlink
existe : `ls codegraph-toolkit/packages/codegraph/node_modules/@liby/salsa`.

### Étape 2 — `parseFile` query

Créer `packages/codegraph/src/incremental/queries.ts` :

```ts
import { input, derived } from '@liby/salsa'
import { Project, type SourceFile } from 'ts-morph'
import * as fs from 'node:fs'
import { sharedDb as db } from './database.js'

// Input : contenu brut d'un fichier
export const fileContent = input<string, string>(db, 'fileContent')

// Input : tsconfig path (rare change)
export const tsConfigPath = input<string, string | undefined>(db, 'tsConfigPath')

// Derived : ts-morph Project (1 par tsconfig + set de files)
// IMPORTANT : ts-morph Project est lourd à créer (~3s). On en partage un
// par appel de analyze(). Pour Sprint 2, garder le Project hors-Salsa et
// passer le SourceFile en input. Sprint 3 verra si on Salsa-isze le Project.

// Derived : SourceFile pour un path
export const sourceFile = derived<string, SourceFile | undefined>(
  db, 'sourceFile',
  (path) => {
    const _ = fileContent.get(path)  // dep sur le contenu
    return getOrAddSourceFile(path)  // helper qui réutilise le Project global
  },
)
```

Décision tactique : pour Sprint 2, le `Project` ts-morph reste GLOBAL et
non-Salsa. C'est un compromis — le Project "owne" tous les SourceFile, donc
le mettre en query Salsa demande un refactor profond. Sprint 3 ou 4
décidera si on le fait. Pour Sprint 2, `sourceFile.get(path)` retourne un
SourceFile depuis un Project pré-existant, et la dépendance `fileContent`
suffit à invalider correctement.

### Étape 3 — Migrer env-usage

Créer `packages/codegraph/src/incremental/env-usage.ts` qui :
1. Reçoit la liste de fichiers en input (ou query)
2. Pour chaque fichier, query `envUsageOfFile(path) -> EnvVarReader[]`
3. Agrège via `allEnvUsage() -> EnvVarUsage[]`

```ts
export const envUsageOfFile = derived<string, EnvVarReader[]>(
  db, 'envUsageOfFile',
  (path) => {
    const sf = sourceFile.get(path)
    if (!sf) return []
    return scanEnvReadersInSourceFile(sf, path)  // refactor de l'ancien core
  },
)

export const allEnvUsage = derived<string, EnvVarUsage[]>(
  db, 'allEnvUsage',
  (_label) => {
    const files = projectFiles.get('all')
    const byName = new Map<string, EnvVarReader[]>()
    for (const f of files) {
      for (const r of envUsageOfFile.get(f)) {
        const name = r.varName
        if (!byName.has(name)) byName.set(name, [])
        byName.get(name)!.push(r)
      }
    }
    // ... build EnvVarUsage[] et trier
  },
)
```

NB : aujourd'hui `analyzeEnvUsage` est dans `extractors/env-usage.ts` et
prend (rootDir, files, project). Il fait tout d'un coup. La migration =
le découper en deux niveaux : `scanEnvReadersInSourceFile(sf, path)`
réutilisable côté Salsa, et `analyzeEnvUsage` legacy qui appelle le
helper en boucle.

### Étape 4 — Migrer oauth-scope-literals

Même pattern, plus simple (regex sur contenu, pas d'AST). Crée :
- `oauthScopesOfFile(path) -> OauthScopeLiteral[]`
- `allOauthScopeLiterals() -> OauthScopeLiteral[]`

### Étape 5 — Wire dans `analyze()`

Ajouter au `AnalyzeOptions` un flag `incremental: boolean`. Dans `analyze()` :

```ts
if (options.incremental) {
  // Inputs : set fileContent pour chaque fichier (lit le filesystem)
  for (const f of files) {
    fileContent.set(f, await readFile(absPath(f)))
  }
  projectFiles.set('all', files)
  // Outputs : query les agrégats
  snapshot.envUsage = allEnvUsage.get('all')
  snapshot.oauthScopeLiterals = allOauthScopeLiterals.get('all')
  // ... autres détecteurs en mode legacy si pas migrés
}
```

Le `Project` ts-morph reste créé classiquement (createSharedProject). Il
sera "compagnon" des queries Salsa.

### Étape 6 — Tests

`tests/incremental.test.ts` :
- Smoke : analyze incremental + analyze incremental sans changement → 2e run < 100ms (cache hit massive)
- Smoke : modify 1 file, re-analyze → seul ce fichier reparse (vérifier via `db.stats()`)
- Match : output incremental === output legacy sur la même DB

### Étape 7 — Build + commit

```sh
cd codegraph-toolkit
npx tsc -b packages/codegraph
npx vitest run
git add packages/codegraph CLAUDE-CONTEXT.md
git commit -m "feat(codegraph): incremental mode (Sprint 2 — parseFile + env-usage + oauth-scope-literals)"
```

### Mesure attendue Sprint 2

Sur Sentinel :
- 1er `analyze --incremental` : 5-7s (initial load complet + Salsa overhead)
- 2e `analyze --incremental` (pas de modif) : <500ms (full cache hit)
- Modif de 1 fichier puis 3e : ~1s (seul ce fichier réparse pour env-usage + oauth-scopes)

Si 2e run > 1s, c'est qu'un détecteur dépend de quelque chose qui invalide
trop largement. Diagnostic via `db.stats().misses` — qui doit être 0 sur
les queries non touchées.

## Sprint 3 — Migrate remaining detectors ✅ DONE (commits 92eabe3, 4756b92, cb6309d, b6c2bb6)

13/14 détecteurs migrés selon le pattern uniforme. unused-exports
volontairement reporté (refactor dédié, pas un wrap).

Mesures réelles sur Sentinel (~600 fichiers TS) :
- Cold incremental : 16.4s (vs 19.2s legacy → -15%)
- Warm incremental (2e run sans modif) : 12.9s (-21% vs cold)
- Counts cross-mode bit-pour-bit identiques

Le warm n'atteint PAS la cible <500ms du boot brief original.
Diagnostic :
- File discovery + Project ts-morph build non-cachés (~5s)
- Inputs Salsa réécrits à chaque run (set boucle sur tous les fichiers
  même si fileContent identique → bumps revision)
- Agrégats globaux dépendent d'inputs reconstruits (typedCalls,
  graphEdges, manifests) → invalidation totale même si data identique
- Persistence disque DB Salsa absente (cache cross-process)

Toutes ces améliorations sont chantier Sprint 5+.



### Liste à migrer (dans l'ordre suggéré)

Par complexité croissante :

1. **event-emit-sites** (similaire à env-usage — AST scan local)
2. **package-deps** (lit package.json + scan imports — ajouter `packageJson` en input)
3. **barrels** (lit AST par fichier, agrège)
4. **truth-points** (touch DB plus complexe — déps sur SQL writers/readers)
5. **state-machines** (enums + writes — multi-aspect mais local)
6. **typed-calls** (signatures + call edges, cross-file → query par fichier + agrégat global)
7. **cycles** (Tarjan SCC sur graph d'imports — peut être query globale qui invalide quand 1 import change)
8. **data-flows** (BFS sur typed-calls + emit/listen — déps lourdes sur typed-calls)
9. **symbol-refs** (dépend de typed-calls + sourceFiles — gros graph)
10. **complexity** (par fichier — facile)
11. **unused-exports** (besoin de tous les autres pour comparer — globale, recompute si N'IMPORTE QUEL fichier change... à étudier)
12. **taint** (rules-driven, AST scan)
13. **module-metrics** (PageRank — globale, recompute si edges change)
14. **component-metrics** (idem au niveau dossier)

### Pattern de migration par détecteur

Chaque détecteur en mode legacy a une signature comme :
```ts
export async function analyzeXxx(
  rootDir: string, files: string[], project: Project, options?: ...,
): Promise<XxxResult[]>
```

Le wrap Salsa :
```ts
// 1. Helper sur 1 fichier (extrait de la fonction batch)
function scanXxxInSourceFile(sf: SourceFile, path: string): XxxResult[] { ... }

// 2. Query par fichier
export const xxxOfFile = derived<string, XxxResult[]>(
  db, 'xxxOfFile', (path) => {
    const sf = sourceFile.get(path)
    if (!sf) return []
    return scanXxxInSourceFile(sf, path)
  },
)

// 3. Agrégat global
export const allXxx = derived<string, XxxResult[]>(
  db, 'allXxx', (_label) => {
    const files = projectFiles.get('all')
    return files.flatMap(f => xxxOfFile.get(f))
    // + tri/dedup si nécessaire
  },
)

// 4. Legacy keepa : analyzeXxx() reste dispo pour le mode non-incremental
//    et appelle scanXxxInSourceFile() en boucle (réutilise la même logique)
```

### Détecteurs particuliers

**unused-exports** : peut être migré différemment. Au lieu de "global qui
invalide tout", l'split par fichier + une query "is symbol X imported by
anyone ?" évite la recompute massive. Mais c'est un refactor, pas du wrap.
À discuter en Sprint 3.

**typed-calls** + **data-flows** : interdépendants. typed-calls expose
signatures + edges, data-flows BFS dessus. Les deux doivent être
incrémentalisés ensemble (data-flows query depend on typed-calls
queries).

**module-metrics / cycles** : ces queries sont GLOBALES — elles
recomputent dès qu'un edge import change. Acceptable pour Sprint 3,
optimisable plus tard via "edge-level diff" si besoin.

### Tests

À chaque détecteur migré : ajouter un test dans `tests/incremental.test.ts`
qui vérifie :
- Output incremental === output legacy
- 2e run sans modif → cache hit
- Modif d'1 fichier non-relié → 0 recompute du détecteur
- Modif d'1 fichier relié → 1 recompute du fichier + recompute des
  agrégats (mais pas des autres fichiers)

### Build + commit

Faire un commit par détecteur ou par batch logique (max 3-4 par commit
pour rester reviewable).

## Sprint 4 — Decommission factsOnly + --regen

### Goal

Une fois tous les détecteurs en Salsa, le mode `factsOnly` (M8) devient
inutile : un analyze incremental complet est plus rapide que factsOnly
était. On retire `factsOnly` + `--regen` pour simplifier l'API.

### Étape 1 — Bench

Mesurer sur Sentinel :
- `analyze --incremental` cold (pas de cache) : durée
- `analyze --incremental` warm (cache plein, pas de modif) : durée
- `analyze --incremental` après 1 modif : durée

Cible : warm < 500ms, post-modif < 1s. Si non atteint, repérer les
queries lentes via stats.

### Étape 2 — Mode unique

Remplacer `analyze()` legacy par `analyze()` qui est **toujours**
incremental. Supprimer le flag `factsOnly`. Le code legacy des extractors
batch peut rester (réutilisé en interne par les helpers per-file) mais le
chemin orchestrator unique passe par Salsa.

### Étape 3 — CLI

`codegraph analyze` → mode incremental par default.
`codegraph facts --regen` → simplement `codegraph facts` (régen est
gratuit avec Salsa warm).

Garder un flag `--cold` pour forcer un reset DB si besoin de debug.

### Étape 4 — Pre-commit Sentinel

Le hook `scripts/git-hooks/pre-commit` peut soit :
- garder `codegraph facts` (qui sera maintenant rapide nativement)
- ou le retirer entièrement si la DB Salsa est persistée entre runs

Décision : pour Sprint 4 v1, garder `codegraph facts` au pre-commit. Une
DB Salsa persistée disque = chantier futur (Sprint 5 hypothétique).

### Étape 5 — ADR-022 update

Mettre à jour `sentinel-core/docs/adr/022-datalog-invariants.md` section
"Régen automatique" : indiquer que tout passe par Salsa, plus de mode
factsOnly.

### Étape 6 — Commit

```
feat(codegraph): mode incremental par default, retire factsOnly (Sprint 4)
```

## Comment vérifier que tout marche

À chaque étape de chaque sprint :

```bash
cd ~/Documents/codegraph-toolkit
npx tsc -b                                    # build clean tous les packages
npx vitest run                                # tous les tests passent

cd ~/Documents/Sentinel
cd sentinel-core && npx tsc --noEmit          # tsc clean
npx vitest run tests/unit                     # invariants ts-morph + datalog passent

# Sanity end-to-end
cd ~/Documents/Sentinel
npx codegraph analyze                         # toujours marche en mode legacy
node /Users/mariustranchier/Documents/codegraph-toolkit/packages/datalog/dist/cli.js \
  run sentinel-core/invariants \
  --facts .codegraph/facts                    # 0 violation
```

Si un test casse, c'est CASSANT et c'est OK : déboguer avant de continuer.
Ne jamais "skipper" un test qui pète.

## Décisions architecturales prises (ne pas revenir dessus)

- **Approche (2)** : refactor profond. Tous les détecteurs deviennent
  des queries Salsa, pas seulement parseFile. Cf. l'échange "approche (1)
  vs (2)" — (2) éclipse (1) sur le long terme.
- **Salsa runtime maison.** Pas de dépendance externe (pas Salsa-rs via
  WASM, pas Recoil, pas anything). Pure TS. ~600 lignes prod.
- **Sync only.** Sprint 1 a posé ça en dur. Si un jour besoin async :
  major version bump.
- **Project ts-morph reste global** au moins pour Sprint 2 (compromis).
  Sprint 3 ou 4 verra si on l'incrémentalise.

## Reprise rapide checklist

Quand tu reprends dans une nouvelle session :

1. [ ] Lire CE FICHIER en entier
2. [ ] `git log --oneline | head -20` côté codegraph-toolkit + Sentinel
3. [ ] Vérifier que `npx vitest run` côté toolkit passe (106/106 attendus)
4. [ ] Vérifier que les invariants Sentinel passent (659/659)
5. [ ] **Sprint 7** hypothétique : persistence disque DB Salsa pour
       atteindre warm <500ms via CLI (process neuf). Sérialiser cells +
       revision dans `.codegraph/salsa-cache.json`. Charger au démarrage,
       sauver à la fin de analyze().
6. [ ] **Sprint 8** : retirer factsOnly + --regen (cold via CLI doit
       battre factsOnly d'abord — soit via persistence Sprint 7, soit
       via une autre optim).
7. [ ] **Sprint 9** : migrer event-bus / http-routes / bullmq-queues /
       db-tables en Salsa (faible priorité — ces détecteurs sont déjà
       rapides via le shared Project Sprint 6).
8. [ ] **Sprint 10** : refactor unused-exports en queries Salsa fines
       (`isImportedBy(symbol)`) si on veut sortir du recompute global
       sur changement.

Si un step ne matche plus exactement la réalité (ex: nouveau commit
intercalé), adapte mais reste fidèle au principe : Salsa partout,
détecteurs en queries, pas de magie.

---

**Question avant de coder Sprint 2 :** confirme avec Marius l'approche du
Project ts-morph "global non-Salsa". C'est un compromis et il peut
préférer le faire en Salsa direct.
