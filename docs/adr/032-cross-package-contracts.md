# ADR-032: Cross-package contracts — tests CI + SemVer cohérents

**Date:** 2026-05-11
**Status:** Accepted

## Rule

> Tout package du workspace qui dépend d'un autre (e.g. `dashboard-server`
> consomme `@liby-tools/codegraph/snapshot-loader`) DOIT :
>
> 1. Avoir un **range de version cohérent** dans `dependencies` — pas
>    de caret `^0.X` quand le workspace utilise `0.Y` où `Y > X`.
> 2. Être couvert par un **test cross-package** en CI (`tests/cross-package/<consumer>.test.ts`)
>    qui import les exports utilisés et vérifie qu'ils sont fonctionnels.
>
> Une modification dans le package upstream qui retire / renomme un export
> consommé pète CI immédiatement, AVANT le merge — pas en cascade
> post-merge.

## Why

Audit du 2026-05-11 (suite ADR-030) — deux observations factuelles :

### 1. Cascade post-P2 ADR-027 réelle

Après merge de la PR #37 (snapshot.json v2), **8 fichiers consumers**
ont dû être fixés en post (PR #38, #39) parce qu'ils lisaient l'ancien
format. Aucun garde-fou structurel n'a alerté avant le merge.

Sites affectés : `codegraph-mcp/snapshot-loader.ts`, `codegraph-mcp/tools/changes-since.ts`,
`dashboard-server/state.ts`, `dashboard-server/routes/snapshot.ts`,
`dashboard-server/routes/diff.ts`, `dashboard-server/watch/file-watcher.ts`,
`examples/canary-project/validate.sh`, `scripts/git-hooks/codegraph-feedback-impl.mjs`.

Tous cumulent ~200 LOC de fixes qu'on aurait pu détecter au CI.

### 2. Bug latent SemVer dans `adr-toolkit`

`packages/adr-toolkit/package.json` déclare :
```json
"@liby-tools/codegraph": "^0.3.0"
```

`^0.3.0` = `>=0.3.0 <0.4.0`. Mais `codegraph` actuel est en **0.6.2**
et `adr-toolkit` consomme ses APIs (e.g. `loadSnapshotFromFile`)
ajoutées en 0.6.

Le workspace npm masque le bug : tous les packages partagent la version
locale via symlink, peu importe le range. Mais à la publication
standalone, l'install pèterait ou prendrait la 0.3 du registry.

Audit déclenché par la question méta du 2026-05-11 : *"qu'est-ce qui va
nous bloquer plus tard ?"*. Ce bug est INVISIBLE aux détecteurs et aux
tests existants. Il n'éclate qu'à la publication.

## How to apply

### Tests cross-package (garde-fou opérationnel)

- Pour chaque consumer cross-package (= package A qui importe d'un
  package B du workspace), créer
  `packages/<consumer>/tests/cross-package-<package-B>.test.ts`.
- Le test import explicitement chaque module utilisé en prod via le
  chemin d'export PUBLIC :
  ```ts
  import { loadStoredSnapshot } from '@liby-tools/codegraph/snapshot-loader'
  import { unwrapSnapshot, isSafeSnapshotFilename } from '@liby-tools/codegraph/snapshot-loader'
  ```
- Smoke test : appeler chaque fonction avec un input valide minimal,
  asserter un comportement basique. Le but n'est pas de tester la
  logique métier (= déjà couverte par les tests unitaires du package
  upstream), mais de **détecter une rupture du contract d'export**.
- Si le package upstream supprime/renomme un export utilisé, ce test
  pète au CI **avant le merge**, plutôt qu'en cascade après.

### Ranges de versions cohérents

- Chaque `dependencies` cross-workspace doit avoir un range qui matche
  les exports utilisés. Pas de `^0.3.0` quand on consomme du 0.6.x.
- Convention pour ce projet : utiliser `">=<version-courante>"` ouvert
  vers le haut (ex: `">=0.6.0"`) jusqu'à v1.0 où SemVer strict
  s'applique.
- À chaque release du package upstream, mettre à jour les ranges des
  consumers — pas critique pour le workspace mais essentiel pour la
  publication.

### Liste des exports publics par package (= contractuel)

Document ce qui EST stable vs INTERNE dans chaque package via le champ
`exports` du `package.json`. Tout ce qui n'est pas listé dans `exports`
n'est pas un contrat — peut bouger sans préavis.

`@liby-tools/codegraph` exports actuels (= contrats stables) :
- `.` — main entry
- `./synopsis` — synopsis builder
- `./synopsis/adr-markers`
- `./diff` — diff helpers
- `./snapshot-loader` — loader unifié (ADR-030)
- `./scripts/datalog-check-fast.mjs` — script utilisé par hooks
  externes (adr-toolkit `codegraph-feedback.sh`)
- `./package.json` — convention pour permettre aux consumers de lire
  `version`, `bin`, etc.

Tout autre module est interne — un consumer qui importe via un chemin
non listé (`@liby-tools/codegraph/dist/foo`) viole le contrat et casse
quand le code interne bouge.

### Gotcha : `node_modules` nested vs symlink workspace

Si un sous-package contient un `node_modules/@liby-tools/codegraph/` qui
est une **copie statique** (pas un symlink vers `../../codegraph`), il
peut consommer une vieille version freezée incohérente avec le
workspace. Symptôme : `npm test` au sous-package utilise la copie
ancienne tandis que le développeur ajoute des features dans le
workspace.

Fix : `rm -rf packages/<X>/node_modules/@liby-tools/<Y>` puis `npm install`
au root. Les tests cross-package détectent ce cas — si la copie est
ancienne, le test échoue parce que les nouveaux exports manquent.

## Anti-patterns

- **Importer un chemin non listé dans `exports`** (= `@liby-tools/codegraph/internal/foo`).
  Le workspace l'autorise mais le contract n'est pas garanti.
- **Caret SemVer `^0.X.Y` qui masque un decalage** : `^0.3.0` accepte
  `0.3.x` mais pas `0.4+`. Si on consomme du 0.6 via workspace, on a
  un bug latent.
- **Test cross-package qui re-implémente la logique** : le but est de
  détecter la rupture du contrat d'export, pas de re-tester la logique
  du package upstream. Smoke tests minimaux suffisent.
- **Ajouter un test cross-package pour CHAQUE fonction utilisée** :
  trop verbeux. Couvrir les **modules** utilisés (= entrées de
  `exports`), pas chaque function granulaire.

## Anchored in

<!-- AUTO-GÉNÉRÉ depuis les marqueurs ADR-NNN du code source. Voir @liby-tools/adr-toolkit. NE PAS éditer à la main. -->

- `packages/codegraph/src/index.ts`


## Tested by

- `packages/codegraph-mcp/tests/cross-package-codegraph.test.ts`
- `packages/dashboard-server/tests/cross-package-codegraph.test.ts`
- `packages/adr-toolkit/tests/cross-package-codegraph.test.ts` (à créer
  si adr-toolkit a des tests vitest, sinon différer)

## Detail

### Pourquoi pas API Extractor / @arethetypeswrong/cli ?

Considéré. Rejeté pour ce projet :
- API Extractor (Microsoft) génère un `.api.md` qui documente la surface
  d'API. Ajoute une dep + un fichier à reviewer à chaque PR. Valeur
  marginale pour 2 devs + workspace npm.
- `@arethetypeswrong/cli` check les exports types. Catch les bugs de
  types mais pas les runtime breaks (= ce qu'on a vu en cascade P2).

Les tests cross-package vitest catchent les deux (types + runtime) sans
nouvelle dep.

### Pourquoi pas un mono-package ?

Considéré comme alternative radicale (= fusionner codegraph + codegraph-mcp
+ dashboard-server en un seul package). Rejeté parce que :
- `codegraph` (CLI + lib) et `codegraph-mcp` (MCP server) ont des
  consumers différents (CLI users vs MCP clients) → packaging séparé
  cohérent.
- `dashboard-server` est un service web optionnel — pas tout le monde
  veut l'installer avec le CLI.
- Le coût de garde-fou cross-package (= tests) est inférieur au coût
  de fusion + maintenance d'un mono-package qui contient tout.

### Pourquoi maintenant ?

Le pain est déjà mesuré (cascade P2 → 200 LOC fix réactif). À chaque
nouveau format ou refactor des exports, ce coût se répète. Le coût du
garde-fou (= ~1 jour pour tous les tests) s'amortit dès la prochaine
refonte.

ADR-031 (= sub-snapshots, prochain gros chantier) modifiera le format
sérialisé. Sans tests cross-package, on reprend la cascade.

## References

- ADR-030 — schéma JSON vs types internes (= la frontière publique
  qu'on protège)
- ADR-027 (P1-P3) — la source du problème (cascade observée P2)
- ADR-029 — signaux propres avant refonte (même esprit : garde-fou
  structurel avant de modifier)
