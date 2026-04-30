# Enrichissement codegraph — 5 axes (post-refactor analyzer)

> **Pour Claude qui reprend dans une nouvelle session :** lis CE FICHIER
> EN ENTIER avant toute action. Contexte = post-refactor Phase A+B+C de
> analyzer.ts (cf. `REFACTOR-ANALYZER-PLAN.md`). 14 détecteurs migrés
> au pattern `Detector/Registry`. analyze() = 157 LOC d'orchestration.

## Origine

Marius a demandé "qu'est-ce que codegraph t'expose qui te permettrait de
voir vers quoi améliorer codegraph pour qu'il t'aide encore plus ?".
J'ai analysé codegraph sur lui-même (`npx codegraph analyze`) et identifié
5 angles morts. Marius a validé les 5 et demandé l'implémentation
étape-par-étape. Ce doc est le boot brief de reprise.

## Les 5 axes (ordre d'implémentation choisi : du plus petit/ratchet au plus gros)

### Axe 5 — Cycle blocker auto via Datalog ratchet (~1h)

**Objectif** : empêcher toute nouvelle régression de cycle d'import sans
bloquer sur l'existant.

**Plan** :
1. Créer `sentinel-core/invariants/cycles-no-new.dl` avec :
   - `Cycle(file)` dérivé des facts produits par codegraph (la rule
     `CycleEdge(from, to)` existe-t-elle déjà ? si non l'ajouter via
     `packages/codegraph/src/facts/`).
   - `CycleGrandfathered(file)` ratchet pour les fichiers actuellement
     dans un cycle (1 cycle connu : `bootstrap.ts ↔ bootstrap-fsm.ts`
     dans adr-toolkit, si appliqué à codegraph-toolkit ; sur Sentinel
     vérifier `npx codegraph analyze` cycles).
   - `CycleViolation(file)` = `Cycle(file)`, NOT `CycleGrandfathered(file)`.
2. Le test `tests/unit/datalog-invariants.test.ts` exécute déjà toutes
   les `.dl` — pas de test TS à ajouter.
3. Vérifier que codegraph émet bien `CycleEdge` ou équivalent dans
   `.codegraph/facts/`. Sinon ajouter dans `packages/codegraph/src/facts/`.
4. Documenter dans un nouvel ADR (ADR-023) ou en append d'ADR-022 si
   plus simple.

**Validation** : 150/150 tests + nouveau test invariant qui passe.

**Risque** : si codegraph n'émet pas encore les facts cycles, il faut
d'abord les ajouter aux facts emit dans `packages/codegraph/src/facts/`.

### Axe 4 — State machines `detectionConfidence: 'observed'|'declared-only'` (~2h)

**Objectif** : séparer les FSM détectées via writes observés (sûr) des
FSM avec enum/type alias seul (incertain — peut-être bug détecteur, ou
vraiment orphelines).

**Plan** :
1. Modifier `core/types.ts` `StateMachine` : ajouter
   `detectionConfidence: 'observed' | 'declared-only'`.
2. Modifier `extractors/state-machines.ts` : si `writers.length > 0`,
   `'observed'`, sinon `'declared-only'`.
3. Idem pour le path Salsa (`incremental/state-machines.ts`).
4. Tests : étendre `tests/state-machines.test.ts` pour vérifier les
   deux confidence levels.
5. Hook `scripts/codegraph-feedback.sh` : afficher le confidence dans
   la section state-machines (déjà en place ? vérifier).

**Validation** : parité bit-pour-bit pour les FSM observed (champ ajouté
mais valeur identique). Les FSM declared-only étaient absentes/incomplètes
avant — leur structure est nouvelle.

**Risque** : changement de schéma — vérifier que les consumers du
snapshot (codegraph-mcp, sentinel hooks) ne pètent pas. Si un consumer
fait `.writers.length` sans vérif, OK. Si un consumer suppose que toutes
les FSM ont writers, ajuster.

### Axe 2 — Co-change temporel (~3h)

**Objectif** : extraire des paires `(fichier_A, fichier_B)` co-modifiées
N fois sur K commits récents → signal énorme dans le hook PostToolUse.
"Tu touches reporter.ts ? les 5 dernières fois t'as aussi touché
alert-system.ts dans 4 commits."

**Plan** :
1. Nouveau extractor `packages/codegraph/src/extractors/co-change.ts` :
   - Input : git log --name-only --since=N (N=90 jours par défaut).
   - Algo : pour chaque commit, extraire la liste des fichiers
     modifiés. Compter les paires (a, b) où a < b. Filtrer paires avec
     count >= seuil (défaut 3).
   - Output : `CoChangePair[]` = `{ from, to, count, lastTogether,
     totalCommitsA, totalCommitsB, jaccard }`.
2. Nouveau detector `core/detectors/co-change-detector.ts` (ne pas
   factsOnly-eligible — git I/O coûteux, skip en factsOnly).
3. Snapshot : ajouter `coChangePairs?: CoChangePair[]` dans
   `GraphSnapshot`.
4. Patch helper `patchSnapshotWithDetectorResults` : ajouter mapping
   `'co-change' → 'coChangePairs'`.
5. Nouveau MCP tool `codegraph_co_changed(file_path)` dans
   `packages/codegraph-mcp/src/tools/co-changed.ts` : retourne le top-N
   des fichiers co-modifiés avec le file donné.
6. Hook `scripts/codegraph-feedback.sh` : section "Souvent modifié
   ensemble" si le file a co-change pairs avec count >= 3.

**Validation** : parité N/A (nouveau champ). Test unitaire sur fixtures
git (créer un repo de test avec 5 commits orchestrés).

**Risque** : git log peut être lent sur gros repos (Sentinel ~1k
commits). Cap à 90 jours par défaut, configurable. Cache les résultats
par hash du HEAD.

### Axe 1 — Symbol-level dans le MCP (~4h, le plus gros)

**Objectif** : `codegraph_who_calls(symbol)` exploite
`typedCalls.callEdges` pour donner les call sites avec types contractuels
observés au site d'appel. Plus `codegraph_extract_candidates(file)` qui
croise longFunctions × symbol-fanIn pour suggérer des extractions.

**Plan** :
1. Nouveau MCP tool `codegraph_who_calls(symbol_id)` dans
   `packages/codegraph-mcp/src/tools/who-calls.ts` :
   - Input : `symbol_id` au format `file:symbolName` (ex
     `src/foo.ts:bar`).
   - Lit le snapshot depuis `.codegraph/snapshot-*.json`.
   - Filtre `snapshot.typedCalls.callEdges` où `to === symbol_id`.
   - Retourne `[{ from: 'file:caller', line, inputTypes, outputType }]`.
2. Nouveau MCP tool `codegraph_extract_candidates(file_path)` dans
   `packages/codegraph-mcp/src/tools/extract-candidates.ts` :
   - Input : file path.
   - Croise `snapshot.longFunctions` (du file) avec `snapshot.symbolRefs`
     (count des refs entrantes par symbol).
   - Score = `loc * fanIn / 10` (à tuner).
   - Retourne top-N candidates avec score + raison.
3. Enregistrer dans `packages/codegraph-mcp/src/server.ts` (ou index.ts).
4. Tests unitaires sur fixtures.
5. Documenter dans le README de codegraph-mcp + le CLAUDE.md de
   Sentinel (section LSP MCP au-dessus de codegraph MCP).

**Validation** : tests passent + appel manuel via codegraph-mcp running.
Le hook PostToolUse pourrait optionnellement appeler ces tools mais
c'est cher (loadsnapshot 8MB) — probablement pas dans le hook, juste
exposé en MCP.

**Risque** : `symbolRefs` et `typedCalls.callEdges` ont des formats
différents (l'un `{from, to, line}`, l'autre avec types). Vérifier que
le `symbol_id` a le même format dans les deux. Si pas, normaliser dans
le tool.

### Axe 3 — Truth-point + data-flow coverage IRL — **OBSOLÈTE**

**Statut (2026-04-30)** : investigation menée, **faux problème confirmé**.

**Investigation** :
- Snapshot Sentinel : **160 dataFlows réels** (toutes des routes HTTP
  `GET /api/accounts`, `POST /api/approvals/resolve`, etc.) +
  **71 truthPoints réels** (`sentinel_counters`, `trust_scores`,
  `approvals` avec writers=3 readers=10, etc.).
- Snapshot codegraph-toolkit : 10 dataFlows tous dans fixtures.
- Grep code source toolkit : aucun `app.get()`, aucun `bus.emit()`,
  aucun event listener runtime. Le seul `server.setRequestHandler` est
  le protocole MCP (handler générique). Le seul `server.listen` est
  optionnel pour servir un panneau web.

**Conclusion** : codegraph-toolkit est un CLI/library sans routes ni
listeners runtime — c'est juste sa nature. Le détecteur marche
parfaitement (validé sur Sentinel app). Pas de bug à fixer.

**Pas de code change.** Axe 3 retiré du backlog actif.

## Ordre d'exécution recommandé

1. **Axe 5** (cycle blocker, 1h) — pose le pattern "Datalog facts +
   ratchet" pour codegraph lui-même. Plus petit, valide le flow.
2. **Axe 4** (FSM confidence, 2h) — petit changement de schéma,
   parité bit-pour-bit garantie, peu risqué.
3. **Axe 2** (co-change, 3h) — nouveau extractor + nouveau MCP tool
   + nouveau hook section. Non-bloquant pour la parité.
4. **Axe 1** (symbol MCP, 4h) — exploitation des données déjà émises
   par typedCalls. Pas de modif analyzer, que MCP tools.
5. **Axe 3** (data-flow IRL, 6h) — investigation d'abord. Si vrai
   problème, ~6h. Sinon retirer du backlog.

**Statut final (2026-04-30) — TOUT LIVRÉ + Axe 3 marqué obsolète :**

| Axe | Commit toolkit | Commit Sentinel | Statut |
|---|---|---|---|
| 5 — cycles blocker | `63b9a45` | `e2a244c` | ✓ livré |
| 4 — FSM confidence | `b0b7cfa` | (parité préservée, pas de change) | ✓ livré |
| 2 — co-change | `c9da515` | `0db732c` (hook) | ✓ livré |
| 1 — symbol-level MCP | `1a239bd` | (pas de change Sentinel) | ✓ livré |
| 3 — data-flow IRL | (n/a) | (n/a) | ✗ obsolète (faux problème) |

**Total réel : ~7h sur 1 session** (vs estimé 16h sur plusieurs).

## Reprise rapide checklist

À chaque nouvelle session :
1. [ ] Lire CE FICHIER en entier
2. [ ] `git log --oneline | head -10` — voir l'avancement (commits
   préfixés `feat(codegraph-cycles)`, `feat(codegraph-fsm-confidence)`,
   `feat(codegraph-co-change)`, `feat(codegraph-mcp-symbol)`,
   `feat(codegraph-data-flows-irl)`)
3. [ ] `npx vitest run` côté toolkit (toujours ≥150 passants)
4. [ ] Vérifier quel axe est en cours via les TODO ou un fichier
   `WIP.md` que je créerais si le travail dure
5. [ ] Snapshot baseline AVANT chaque change qui touche analyzer/extractors
   (parité bit-pour-bit comme Phase A+B+C)
6. [ ] Commits granulaires : 1 commit par axe minimum, plus si l'axe
   se subdivise naturellement

## Conventions partagées (héritées du refactor analyzer)

- Pas de strip timing/dates pour la parité ; comparer sur
  `JSON.parse → walk strip(timing,generatedAt) → sha256(JSON.stringify)`.
- Pas de breaking change snapshot sans bump version + adapt consumers
  (codegraph-mcp, sentinel hooks).
- Chaque nouveau MCP tool : doc dans `packages/codegraph-mcp/README.md`
  + ajout dans CLAUDE.md de Sentinel.
- Chaque nouveau Datalog `.dl` : suivre ADR-022 (ratchet
  `XGrandfathered(file)`).
