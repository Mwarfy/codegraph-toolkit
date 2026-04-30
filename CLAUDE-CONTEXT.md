<!-- AUTO-GÉNÉRÉ par @liby/adr-toolkit — NE PAS éditer à la main -->

# Boot Brief — codegraph-toolkit

> **À lire AVANT toute action.** Ce fichier est le state-of-the-architecture.
> Si tu modifies un fichier listé dans "Fichiers gouvernés par un ADR" ci-dessous,
> lis l'ADR correspondant AVANT d'éditer.

## Règles architecturales actives (ADRs)

- **ADR-001** — Le synopsis builder (`@liby/codegraph buildSynopsis`) ne fait aucun I/O, > n'invoque aucun LLM, n'utilise aucune source non-déterministe. Même > snapshot d'entrée → même output JSON byte-équivalent.
  → [`Synopsis builder = pur, zéro LLM`](docs/adr/001-synopsis-builder-pure.md)
- **ADR-002** — Aucun path / nom de projet consommateur (Sentinel, Morovar, etc.) ne > doit apparaître dans le code des packages `@liby/codegraph` ou > `@liby/adr-toolkit`. Tout vient de `.codegraph-toolkit.json` ou > `codegraph.config.json` chargés depuis le rootDir du consommateur.
  → [`Config-driven obligatoire — pas de hardcoded projet dans le code des packages`](docs/adr/002-config-driven-no-hardcoded-projects.md)
- **ADR-003** — Le default detector set (`createDetectors([])` ou `defaultDetectorNames()`) > exclut tous les détecteurs marqués `projectSpecific: true`. Pour les > activer, le consommateur doit les nommer explicitement dans > `codegraph.config.json` → `"detectors": [...]`.
  → [`Détecteurs généralistes par défaut, project-specific opt-in`](docs/adr/003-detectors-generaliste-vs-project-specific.md)
- **ADR-004** — Le bootstrap agentique sépare 3 rôles, et aucun ne franchit son périmètre : > > 1. **OÙ regarder** : codegraph + pattern detectors (déterministe). Le > LLM ne décide jamais quels fichiers méritent un ADR. > 2. **COMMENT formuler** : un agent Sonnet par candidat avec prompt > cadré et output JSON forcé. Le LLM rédige Rule + Why + asserts depuis > le code, rien d'autre. > 3. **QUOI accepter** : humain (CLI revue + `--apply` confirmé). Les > ADRs sont écrits avec `Status: Proposed`, jamais `Accepted`.
  → [`Bootstrap = 3 rôles séparés (codegraph détecte / LLM rédige / humain valide)`](docs/adr/004-bootstrap-trois-roles-separes.md)

## Fichiers gouvernés par un ADR (lookup pré-calculé)

- `packages/adr-toolkit/src/bootstrap-writer.ts` → ADR-004
- `packages/adr-toolkit/src/bootstrap.ts` → ADR-004
- `packages/adr-toolkit/src/config.ts` → ADR-002
- `packages/codegraph/src/detectors/block-loader.ts` → ADR-003
- `packages/codegraph/src/detectors/index.ts` → ADR-003
- `packages/codegraph/src/synopsis/builder.ts` → ADR-001
- `packages/codegraph/src/synopsis/tensions.ts` → ADR-001

> **Dogfooding** : ce repo gouverne sa propre architecture via le toolkit qu'il publie. Les 4 ADRs ci-dessus encadrent les invariants critiques (zéro LLM dans synopsis, config-driven, séparation détecteurs, 3 rôles bootstrap).

## Tests d'invariant qui gardent ces règles

- `packages/*/tests/*.test.ts`

## Top hubs (fichiers les plus importés — gros risque de régression si touchés)

- `packages/codegraph/src/core/types.ts` (in: 57)
- `packages/salsa/dist/index.d.ts` (in: 16)
- `packages/codegraph/src/incremental/database.ts` (in: 15)
- `packages/codegraph/src/incremental/queries.ts` (in: 14)
- `packages/adr-toolkit/src/config.ts` (in: 9) · gov by ADR-002
- `packages/codegraph/src/diff/types.ts` (in: 8)
- `packages/datalog/src/types.ts` (in: 8)
- `packages/codegraph/src/check/types.ts` (in: 7)

## ⚠ ADR anchor suggestions

Fichiers load-bearing (in-degree élevé ou truth-point) **sans aucun marqueur `// ADR-NNN`** dans le code. Intentionnel ? Sinon poser un marqueur ou créer un ADR :

- **57** `packages/codegraph/src/core/types.ts` _(top-hub)_
- **16** `packages/salsa/dist/index.d.ts` _(top-hub)_
- **15** `packages/codegraph/src/incremental/database.ts` _(top-hub)_

## Tensions actives — invitations à explorer

> Convocations courtes pointant vers des frictions détectées dans le code.
> Chaque tension a un **test rapide** pour trancher : hypothèse à vérifier,
> pas verdict. Une tension non explorée n'est pas un bug — c'est un saut
> latéral possible que le sol stable rend testable.

- **CYCLE** `packages/codegraph/src/core/types.ts → packages/codegraph/src/detectors/bullmq-queues.ts` — boucle directe (2 fichiers)  
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
- **DEP-UNUSED** `@liby/codegraph` — déclaré dans packages/adr-toolkit/package.json, jamais importé  
  _→ npm uninstall @liby/codegraph + npm test_
- **DEP-UNUSED** `graphology-operators` — déclaré dans packages/codegraph/package.json, jamais importé  
  _→ npm uninstall graphology-operators + npm test_
- **DEP-UNUSED** `graphology-types` — déclaré dans packages/codegraph/package.json, jamais importé  
  _→ npm uninstall graphology-types + npm test_
- **DEP-UNUSED** `serve-handler` — déclaré dans packages/codegraph/package.json, jamais importé  
  _→ npm uninstall serve-handler + npm test_

## Activité récente (14 derniers jours)

```
4dfd6cc docs(phase-1): refresh boot brief post-Sprint 5
f3af3cb perf(codegraph): warm path optimizations — mtime-aware + Project reuse + skip-set [Sprint 5]
e875f5e docs(phase-1): refresh boot brief post-Sprint 3
b6c2bb6 feat(codegraph): incremental mode — batch 4 final (symbol-refs, taint, metrics) [Sprint 3]
cb6309d feat(codegraph): incremental mode — batch 3 (typed-calls, cycles, data-flows) [Sprint 3]
4756b92 feat(codegraph): incremental mode — batch 2 (complexity, state-machines, truth-points) [Sprint 3]
92eabe3 feat(codegraph): incremental mode — batch 1 (event-emit-sites, package-deps, barrels) [Sprint 3]
0c36ea1 docs(phase-1): refresh boot brief post-Sprint 2
ca6d610 feat(codegraph): incremental mode — env-usage + oauth-scope-literals via Salsa (Sprint 2)
84c8287 fix(salsa): add Database.resetState() — preserve registry across reset
0a3c571 docs: PHASE-1-SALSA-MIGRATION.md — boot brief pour reprendre Sprints 2-4
5d90920 feat(salsa): @liby/salsa runtime — Salsa-style incremental computation (Sprint 1)
```

## Comment contribuer à ce brief

- Une nouvelle décision architecturale ? Crée un ADR via le template :
  `@liby/adr-toolkit/templates/_TEMPLATE.md`
- Le brief sera régénéré au prochain commit.
- Pour forcer une régen : `npx @liby/adr-toolkit brief`
