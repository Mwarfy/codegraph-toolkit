<!-- AUTO-GÉNÉRÉ par @liby-tools/adr-toolkit — NE PAS éditer à la main -->

# Boot Brief — codegraph-toolkit

> **À lire AVANT toute action.** Ce fichier est le state-of-the-architecture.
> Si tu modifies un fichier listé dans "Fichiers gouvernés par un ADR" ci-dessous,
> lis l'ADR correspondant AVANT d'éditer.

## Règles architecturales actives (ADRs)

- **ADR-001** — Le synopsis builder (`@liby-tools/codegraph buildSynopsis`) ne fait aucun I/O, > n'invoque aucun LLM, n'utilise aucune source non-déterministe. Même > snapshot d'entrée → même output JSON byte-équivalent.
  → [`Synopsis builder = pur, zéro LLM`](docs/adr/001-synopsis-builder-pure.md)
- **ADR-002** — Aucun path / nom de projet consommateur (Sentinel, Morovar, etc.) ne > doit apparaître dans le code des packages `@liby-tools/codegraph` ou > `@liby-tools/adr-toolkit`. Tout vient de `.codegraph-toolkit.json` ou > `codegraph.config.json` chargés depuis le rootDir du consommateur.
  → [`Config-driven obligatoire — pas de hardcoded projet dans le code des packages`](docs/adr/002-config-driven-no-hardcoded-projects.md)
- **ADR-003** — Le default detector set (`createDetectors([])` ou `defaultDetectorNames()`) > exclut tous les détecteurs marqués `projectSpecific: true`. Pour les > activer, le consommateur doit les nommer explicitement dans > `codegraph.config.json` → `"detectors": [...]`.
  → [`Détecteurs généralistes par défaut, project-specific opt-in`](docs/adr/003-detectors-generaliste-vs-project-specific.md)
- **ADR-004** — Le bootstrap agentique sépare 3 rôles, et aucun ne franchit son périmètre : > > 1. **OÙ regarder** : codegraph + pattern detectors (déterministe). Le > LLM ne décide jamais quels fichiers méritent un ADR. > 2. **COMMENT formuler** : un agent Sonnet par candidat avec prompt > cadré et output JSON forcé. Le LLM rédige Rule + Why + asserts depuis > le code, rien d'autre. > 3. **QUOI accepter** : humain (CLI revue + `--apply` confirmé). Les > ADRs sont écrits avec `Status: Proposed`, jamais `Accepted`.
  → [`Bootstrap = 3 rôles séparés (codegraph détecte / LLM rédige / humain valide)`](docs/adr/004-bootstrap-trois-roles-separes.md)
- **ADR-005** — Tout détecteur codegraph qui scanne des fichiers TS expose 4 éléments : > 1. Un helper pure `extractXxxFileBundle(sf, relPath, rootDir, project?)` > qui dérive un bundle sérialisable d'UN seul SourceFile. > 2. Si l'agrégation est non-triviale, un helper pure > `aggregateXxxBundles(bundlesByFile)` qui fusionne sans I/O ni AST. > 3. Une fonction batch publique `analyzeXxx(rootDir, files, ...)` qui > compose les deux ci-dessus en boucle (chemin legacy préservé). > 4. Un wrapper Salsa dans `incremental/xxx.ts` exposant > `xxxBundleOfFile(path)` (derived sur `fileContent`) + > `allXxx(label)` (derived qui agrège). > > Aucun détecteur ne mélange I/O async + AST walk + agrégation globale dans > une même fonction batch monolithique.
  → [`Pattern détecteurs codegraph — bundle per-file + agrégat pure`](docs/adr/005-detector-pattern-bundle-per-file.md)
- **ADR-006** — `packages/codegraph/src/core/types.ts` est importé par 57+ fichiers > (top hub absolu du toolkit). Tout type exporté depuis ce fichier est > un contrat avec : > - Les détecteurs (extractors/) qui produisent ces structures > - Les consumers (synopsis/, facts/, diff/, check/) qui les lisent > - Le snapshot.json sérialisé sur disque (consommé par Sentinel, > codegraph-mcp, hooks bash, possibles consumers externes) > > RÈGLE : pas de breaking change sans deprecation explicite. On ajoute > des champs optionnels, on ne supprime ni ne modifie la sémantique > d'un champ existant.
  → [``core/types.ts` est le contract canonique — modifications conservatrices uniquement`](docs/adr/006-core-types-canonical-contract.md)

## Fichiers gouvernés par un ADR (lookup pré-calculé)

- `packages/adr-toolkit/src/bootstrap-fsm.ts` → ADR-004
- `packages/adr-toolkit/src/bootstrap-writer.ts` → ADR-004
- `packages/adr-toolkit/src/bootstrap.ts` → ADR-004
- `packages/adr-toolkit/src/config.ts` → ADR-002
- `packages/codegraph/src/core/types.ts` → ADR-006
- `packages/codegraph/src/detectors/block-loader.ts` → ADR-003
- `packages/codegraph/src/detectors/index.ts` → ADR-003
- `packages/codegraph/src/synopsis/builder.ts` → ADR-001
- `packages/codegraph/src/synopsis/tensions.ts` → ADR-001

> **Dogfooding** : ce repo gouverne sa propre architecture via le toolkit qu'il publie. Les 4 ADRs ci-dessus encadrent les invariants critiques (zéro LLM dans synopsis, config-driven, séparation détecteurs, 3 rôles bootstrap).

## Tests d'invariant qui gardent ces règles

- `packages/*/tests/*.test.ts`

## Top hubs (fichiers les plus importés — gros risque de régression si touchés)

- `packages/codegraph/src/core/types.ts` (in: 75) · gov by ADR-006
- `packages/codegraph/src/incremental/queries.ts` (in: 22)
- `packages/codegraph/src/incremental/database.ts` (in: 20)
- `packages/salsa/dist/index.d.ts` (in: 19)
- `packages/codegraph/src/core/detector-registry.ts` (in: 18)
- `packages/codegraph/src/extractors/_shared/ast-helpers.ts` (in: 14)
- `packages/adr-toolkit/src/config.ts` (in: 10) · gov by ADR-002
- `packages/runtime-graph/src/core/types.ts` (in: 10)

## ⚠ ADR anchor suggestions

Fichiers load-bearing (in-degree élevé ou truth-point) **sans aucun marqueur `// ADR-NNN`** dans le code. Intentionnel ? Sinon poser un marqueur ou créer un ADR :

- **22** `packages/codegraph/src/incremental/queries.ts` _(top-hub)_
- **20** `packages/codegraph/src/incremental/database.ts` _(top-hub)_
- **19** `packages/salsa/dist/index.d.ts` _(top-hub)_
- **18** `packages/codegraph/src/core/detector-registry.ts` _(top-hub)_

## Tensions actives — invitations à explorer

> Convocations courtes pointant vers des frictions détectées dans le code.
> Chaque tension a un **test rapide** pour trancher : hypothèse à vérifier,
> pas verdict. Une tension non explorée n'est pas un bug — c'est un saut
> latéral possible que le sol stable rend testable.

- **ORPHELIN** `packages/adr-toolkit/tests/fixtures/sample-project/src/core/event-bus.ts` — aucun importeur  
  _→ supprimer + npm test : si vert → mort, si rouge → entry-point caché_
- **ORPHELIN** `packages/adr-toolkit/tests/fixtures/sample-project/src/services/state-service.ts` — aucun importeur  
  _→ supprimer + npm test : si vert → mort, si rouge → entry-point caché_
- **ORPHELIN** `packages/codegraph/tests/fixtures/cycles/a.ts` — aucun importeur  
  _→ supprimer + npm test : si vert → mort, si rouge → entry-point caché_
- **ORPHELIN** `packages/codegraph/tests/fixtures/cycles/b.ts` — aucun importeur  
  _→ supprimer + npm test : si vert → mort, si rouge → entry-point caché_
- **ORPHELIN** `packages/codegraph/tests/fixtures/cycles/c.ts` — aucun importeur  
  _→ supprimer + npm test : si vert → mort, si rouge → entry-point caché_
- **FSM-ORPHAN** `ApprovalStatus#expired` — état déclaré mais jamais écrit dans le code  
  _→ supprimer l'état OU ajouter la transition manquante_
- **FSM-ORPHAN** `DocumentPhase#published` — état déclaré mais jamais écrit dans le code  
  _→ supprimer l'état OU ajouter la transition manquante_
- **FSM-ORPHAN** `DocumentPhase#archived` — état déclaré mais jamais écrit dans le code  
  _→ supprimer l'état OU ajouter la transition manquante_
- **FSM-ORPHAN** `NodeStatus#entry-point` — état déclaré mais jamais écrit dans le code  
  _→ supprimer l'état OU ajouter la transition manquante_
- **FSM-ORPHAN** `NodeStatus#uncertain` — état déclaré mais jamais écrit dans le code  
  _→ supprimer l'état OU ajouter la transition manquante_
- **DEP-UNUSED** `jest` — déclaré dans packages/codegraph/tests/fixtures/package-deps/package.json, jamais importé  
  _→ npm uninstall jest + npm test_
- **DEP-UNUSED** `test-only-in-deps` — déclaré dans packages/codegraph/tests/fixtures/package-deps/package.json, jamais importé  
  _→ npm uninstall test-only-in-deps + npm test_
- **DEP-UNUSED** `unused-pkg` — déclaré dans packages/codegraph/tests/fixtures/package-deps/package.json, jamais importé  
  _→ npm uninstall unused-pkg + npm test_
- **BARREL-LOW** `packages/adr-toolkit/src/index.ts` — barrel à 15 re-export(s) pour 0 consumer(s)  
  _→ inline les imports + supprimer le barrel_
- **BARREL-LOW** `packages/codegraph/src/index.ts` — barrel à 8 re-export(s) pour 0 consumer(s)  
  _→ inline les imports + supprimer le barrel_

## Activité récente (14 derniers jours)

```
e73e85d fix(codegraph): break direct cycle sql-helpers ↔ sql-schema via type extraction
e9a2b44 feat(runtime-graph): Phase γ — 4 mathematical disciplines runtime + composite rules
f642620 fix(runtime-graph): CLI rulesDir resolution via __dirname (no package.json export)
cd9a769 feat(runtime-graph): Phase β — replay-tests + chaos + Express + MongoDB + config-driven
ca252d2 fix(runtime-graph): retire grandfathers + refine rules + self-probe E2E validated
e65ea40 feat(runtime-graph): Phase α — runtime observability framework with datalog query language
8c49ff7 fix(analyzer): factsOnly mode must populate TestedFile
6eb35b2 refactor(toolkit): HotAllocation requires ModuleCentrality>200 (FP reduction)
40b2842 refactor(toolkit): SQL DROP/skip-rollbacks + disable noisy composite rules
51d7e5f refactor(toolkit): sql-naming exemptions + ADD/RENAME ordering + edge-case patterns
0c9d608 test(toolkit): contract tests pour CrossDisciplineDetector POC
bbfa9d6 feat(toolkit): SQL ALTER TABLE tracking + CrossDisciplineDetector POC
```

## Comment contribuer à ce brief

- Une nouvelle décision architecturale ? Crée un ADR via le template :
  `@liby-tools/adr-toolkit/templates/_TEMPLATE.md`
- Le brief sera régénéré au prochain commit.
- Pour forcer une régen : `npx @liby-tools/adr-toolkit brief`
