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

- `packages/codegraph/src/core/types.ts` (in: 68) · gov by ADR-006
- `packages/codegraph/src/incremental/queries.ts` (in: 22)
- `packages/codegraph/src/incremental/database.ts` (in: 20)
- `packages/salsa/dist/index.d.ts` (in: 19)
- `packages/codegraph/src/core/detector-registry.ts` (in: 17)
- `packages/adr-toolkit/src/config.ts` (in: 10) · gov by ADR-002
- `packages/codegraph-mcp/src/snapshot-loader.ts` (in: 8)
- `packages/codegraph/src/diff/types.ts` (in: 8)

## ⚠ ADR anchor suggestions

Fichiers load-bearing (in-degree élevé ou truth-point) **sans aucun marqueur `// ADR-NNN`** dans le code. Intentionnel ? Sinon poser un marqueur ou créer un ADR :

- **22** `packages/codegraph/src/incremental/queries.ts` _(top-hub)_
- **20** `packages/codegraph/src/incremental/database.ts` _(top-hub)_
- **19** `packages/salsa/dist/index.d.ts` _(top-hub)_
- **17** `packages/codegraph/src/core/detector-registry.ts` _(top-hub)_

## Tensions actives — invitations à explorer

> Convocations courtes pointant vers des frictions détectées dans le code.
> Chaque tension a un **test rapide** pour trancher : hypothèse à vérifier,
> pas verdict. Une tension non explorée n'est pas un bug — c'est un saut
> latéral possible que le sol stable rend testable.

- **CYCLE** `packages/adr-toolkit/src/bootstrap-fsm.ts → packages/adr-toolkit/src/bootstrap.ts` — boucle directe (2 fichiers)  
  _→ inverser l'import OU extraire dans un 3e fichier_
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
- **DEP-UNUSED** `@liby-tools/codegraph` — déclaré dans packages/adr-toolkit/package.json, jamais importé  
  _→ npm uninstall @liby-tools/codegraph + npm test_
- **DEP-UNUSED** `typescript` — déclaré dans packages/codegraph-mcp/package.json, jamais importé  
  _→ npm uninstall typescript + npm test_
- **DEP-UNUSED** `graphology-operators` — déclaré dans packages/codegraph/package.json, jamais importé  
  _→ npm uninstall graphology-operators + npm test_
- **DEP-UNUSED** `graphology-types` — déclaré dans packages/codegraph/package.json, jamais importé  
  _→ npm uninstall graphology-types + npm test_

## Activité récente (14 derniers jours)

```
6a2da32 feat(phase4-axe1): codegraph_datalog_query — Datalog ad hoc query MCP tool
2494798 docs: PHASE-4-AGENT-FIRST-PLAN — boot brief pour reprise à froid
7c16751 docs: README rewrite — clearer setup path + Phase 1+2+3 features
294de4a feat(adr-toolkit): init détecte la stack DB et active les bons détecteurs
fffe142 feat(codegraph): Drizzle schema detector — mêmes facts que sql-schema
7defd9b feat(codegraph): SQL schema detector — FK sans index + 5 facts Datalog
a934947 feat(codegraph-mcp): codegraph_changes_since MCP tool — diff live vs post-commit
3807758 feat(codegraph): watcher écrit snapshot-live.json + facts à chaque update
26159fc feat(codegraph): reverse-deps BFS — codegraph_affected MCP tool + CLI affected
f65f5c7 docs: clôture du plan d'enrichissement 5 axes — Axe 3 obsolète
1a239bd feat(codegraph-mcp): codegraph_who_calls + codegraph_extract_candidates
c9da515 feat(codegraph): co-change extractor + codegraph_co_changed MCP tool
```

## Comment contribuer à ce brief

- Une nouvelle décision architecturale ? Crée un ADR via le template :
  `@liby-tools/adr-toolkit/templates/_TEMPLATE.md`
- Le brief sera régénéré au prochain commit.
- Pour forcer une régen : `npx @liby-tools/adr-toolkit brief`
