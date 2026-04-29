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

## État à reprise (après Sprint 1)

### Commits livrés sur cette chaîne (codegraph-toolkit)

```
5d90920 feat(salsa): @liby/salsa runtime — Salsa-style incremental computation (Sprint 1)
e75b92b feat(codegraph): factsOnly mode + facts --regen flag (M8)
7ab3214 feat(codegraph): oauth-scope-literals extractor + OauthScopeLiteral facts (M7 prep)
216b48f fix(datalog,codegraph): multi-file ref-check + auto-regen facts in analyze (M3 prep)
b4b7679 feat(datalog): @liby/datalog package — pure-TS interpreter for ADR invariants (M2)
690865c feat(codegraph): event-emit-sites extractor + Datalog facts export (M1)
18f64c6 feat(codegraph,datalog): wrappedIn capture + relax inline fact constraint (M4 prep)
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

- 96/96 tests passent côté toolkit (codegraph 33 + datalog 35 + salsa 28)
- 67/67 invariant tests passent côté Sentinel (incl. datalog-invariants)
- Pre-commit hook Sentinel : tsc + invariants + ADR anchors + brief sync (~17s)
- 3 ADRs migrés en Datalog : ADR-014 (oauth scopes), ADR-017 (event types), ADR-019 (thresholds)
- `codegraph analyze` : full 14s, `--regen` (factsOnly) 7s

### Ce qui est NEUF dans Sprint 1 (et n'est pas encore wiré)

`@liby/salsa` package complet à `packages/salsa/` :
- `src/types.ts` — Revision, Cell, QueryKey, SalsaError
- `src/key-encoder.ts` — encodage canonical déterministe
- `src/database.ts` — storage + registry + stats + reset
- `src/runtime.ts` — `input()`, `derived()`, algorithme red/green deep-verify
- `src/index.ts` — public API
- `tests/` — 4 fichiers, 28 tests

**Aucun consumer ne l'utilise.** Tu peux le supprimer sans casser quoi que
ce soit. C'est volontaire — Sprint 1 livre le runtime, Sprints 2-4 le wire.

## Algorithme Salsa — sémantique subtile (lis-moi)

**2 bugs réels rencontrés en Sprint 1**, à ne pas refaire :

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

## Sprint 2 — Migrate parseFile + 2 detectors PoC

### Goal

Wraper le pipeline ts-morph autour de Salsa pour que `parseFile(path)`
devienne une query. Migrer 2 détecteurs simples (env-usage et
oauth-scope-literals — tous deux ont peu de deps, output stable).

À la fin de Sprint 2 :
- `analyze()` gagne un mode `incremental: true` qui utilise Salsa
- Mode legacy (full + factsOnly) reste intact
- Sur 2 reruns consécutifs sans changement → 2nd run < 1s
- Tests dédiés démontrant le cache hit

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

## Sprint 3 — Migrate remaining detectors

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
3. [ ] Vérifier que `npx vitest run` côté toolkit passe (96/96 attendus)
4. [ ] Vérifier que les invariants Sentinel passent
5. [ ] Décider quel sprint reprendre (probablement Sprint 2 step 1)
6. [ ] Suivre les étapes du plan ci-dessus

Si un step ne matche plus exactement la réalité (ex: nouveau commit
intercalé), adapte mais reste fidèle au principe : Salsa partout,
détecteurs en queries, pas de magie.

---

**Question avant de coder Sprint 2 :** confirme avec Marius l'approche du
Project ts-morph "global non-Salsa". C'est un compromis et il peut
préférer le faire en Salsa direct.
