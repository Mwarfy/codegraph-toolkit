# Phase 4 — Agent-first enrichments

> **Pour Claude qui reprend dans une nouvelle session :** lis CE FICHIER
> EN ENTIER avant toute action. Tu vas oublier le contexte de la
> conversation où ce plan a été conçu — tout ce qu'il faut est ici.

## TL;DR

Phase 1+2+3 ont posé : reverse-deps, watch+snapshot-live, PR diff CI,
changes-since, sql-schema, drizzle-schema, multi-stack init. Le toolkit
peut maintenant cartographier et bloquer des invariants sur projets
TS+raw-SQL ou TS+Drizzle.

Phase 4 recadre le projet : **codegraph-toolkit n'est pas un outil pour
les devs humains qui explorent leur code, c'est une infrastructure
pour l'agent IA qui opère sous pression**. Les "lacunes" identifiées
(visualisation, multi-langage, polish UX) sont **non-priorité**. Ce qui
manque vraiment :

1. Datalog comme query language général — pas que invariants
2. Path queries via control flow sur typedCalls
3. Mémoire inter-sessions (incidents, faux positifs)
4. Détecteur de "drift agentique" (patterns que l'agent crée plus que les humains)
5. Catalogue d'invariants standards portable

Total estimé : **~2 semaines** étalé.

## Recadrage utilisateur (citation textuelle)

> "ce qu'on veut pas forcément faire un outil pour le premier venu mais
> un outil extrêmement puissant pour toi qui sera beaucoup plus utile
> que ce que font les autres. C'est un outil pour toi pas pour des devs
> humains qui veulent juste s'amuser à voir ce que fait l'ia. Non nous
> c'est un projet beaucoup plus important."

Donc le critère de priorisation : **est-ce que ça change ton travail réel
quand tu codes dans Sentinel/Morovar sous pression**. Pas "est-ce que
ça impressionne sur GitHub". Pas "est-ce que c'est plus joli que
CodeGraphContext". Si ça t'évite de :
- Dériver silencieusement en prod
- Repartir de zéro à chaque session sans mémoire
- Réintroduire un cycle / FK non-indexé / parseInt(env) déjà fixé
- Manquer un coupling qui mord cette fois et qui mordra encore

→ priorité haute. Sinon → backlog différé.

## État actuel du toolkit (post Phase 3)

Snapshot des commits récents :

```
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
b0b7cfa feat(codegraph): FSM detectionConfidence — observed vs declared-only
63b9a45 feat(codegraph): émission CycleNode facts + boot brief enrichissement 5 axes
ff7cd93 refactor(codegraph): Phase C — analyze() à 157 LOC via 4 helpers d'orchestration
6029444 refactor(codegraph): Phase B — migration des 13 détecteurs restants
2807c3e refactor(codegraph): Phase A — pattern visiteur Detector/Registry
```

Ce qui marche aujourd'hui :
- 14 détecteurs registry (sql-schema, drizzle-schema, cycles, truth-points, etc.)
- 17 facts Datalog émis (`SqlTable`, `SqlForeignKey`, `CycleNode`, `EmitsLiteral`, etc.)
- 9 MCP tools côté codegraph-mcp
- 7 invariants Datalog Sentinel actifs (cycles-no-new, sql-fk-needs-index, oauth-scopes, ADR-017 events, ADR-019 thresholds, etc.)
- Watch mode → snapshot-live.json, hook PostToolUse lit le frais
- 191/191 tests toolkit
- Multi-stack DB validé bout-en-bout (Sentinel raw SQL + Morovar Drizzle = mêmes invariants)

Reprise rapide :
```bash
cd ~/Documents/codegraph-toolkit
git log --oneline | head -10
npx vitest run                           # doit donner 191/191
cd ~/Documents/Sentinel && npm test      # invariants Datalog 4/4
```

## Les 5 axes Phase 4

### Axe 1 — Datalog comme query language général (~3-4h)

**Objectif** : exposer un MCP tool `codegraph_query(rule_text)` qui exécute
une rule Datalog ad hoc contre les facts émis, et retourne les tuples
`Violation` (ou tout autre output relation déclarée).

**Pourquoi** : aujourd'hui Datalog ne sert qu'aux invariants. Les facts
sont déjà émis (17 relations). Pour répondre à une question structurelle
ad hoc ("trouve tous les fichiers qui ImportEdge transitivement vers X
sans passer par un fichier marqué FileTag('audit')"), je dois coder un
détecteur custom OU faire du BFS programmatique. Avec Datalog comme
query language général : **3 lignes au lieu de 200 LOC**.

**Architecture** :

1. Nouveau MCP tool `codegraph_datalog_query` :
   - Input : `rule_text` (string Datalog), `output_relation` (string,
     défaut "Result")
   - Process : load facts depuis `.codegraph/facts/`, parse + évalue la
     rule via `@liby-tools/datalog`, return les tuples.
   - Output : array de tuples + count.

2. Schéma toujours disponible via `.codegraph/facts/schema.dl`. Le tool
   include automatiquement ce schema avant la rule user.

3. Sécurité : aucune (les facts sont en RAM/disk local, pas de side
   effects côté Datalog runtime). Mais cap raisonnable sur la durée
   d'exécution (timeout 5s).

**Plan d'exécution** :

1. Lire le runtime Datalog : `packages/datalog/src/index.ts` — voir
   `runFromDirs()` et `loadProgramFromDir()` pour comprendre l'API.
2. Créer `packages/codegraph-mcp/src/tools/datalog-query.ts` :
   - Charge facts via `lib.loadFactsFromDir(factsDir)`
   - Charge schema via `lib.loadProgramFromDir(rulesDir)` — ou parse le
     `schema.dl` directement et inject dans la rule user.
   - Compile + execute la rule user.
   - Return outputs.
3. Wire dans `packages/codegraph-mcp/src/index.ts`.
4. Tests fixture : 3-4 rules ad hoc (transitivité imports, FileTag
   filter, agrégation).
5. Document dans le README codegraph-mcp.

**Pièges** :
- Le runtime Datalog peut planter sur rule mal-formed → wrap dans
  try/catch, return error message au lieu de crash.
- Schema include : le runtime exige que les `.input` soient déclarés.
  Le tool doit prepend le `.decl` + `.input` automatiquement (lire
  schema.dl du factsDir et concat).
- Recursive rules : OK, Datalog les supporte. Mais cap sur la profondeur
  de récursion (timeout suffit en pratique).

**Validation** : tester avec une rule "tous les fichiers qui importent
event-bus.ts transitivement" sur Sentinel. Doit retourner ~30 fichiers.

**Estimation** : 3-4h.

### Axe 2 — Path queries via control flow sur typedCalls (~3h)

**Objectif** : exposer des path queries CFG-level via Datalog sur les
facts `typedCalls.callEdges` (déjà émis indirectement via le snapshot).

**Pourquoi** : "trouve tous les chemins d'appel depuis `req.body`/handler
HTTP qui finissent en `db.query` sans passer par `zod.parse`" est
exactement le genre de question CodeQL/Joern. On peut le faire en
Datalog si on a les bonnes relations.

**Architecture** :

Aujourd'hui `typedCalls.callEdges` est dans le snapshot mais PAS émis
en facts Datalog. Première étape : étendre `facts/index.ts` pour émettre :

```
SymbolCallEdge(fromFile:symbol, fromSymbol:symbol, toFile:symbol, toSymbol:symbol, line:number)
SymbolSignature(file:symbol, name:symbol, kind:symbol, line:number)
EntryPoint(file:symbol, kind:symbol, id:symbol)
```

Avec ces 3 relations, des rules transitives deviennent possibles :

```dl
// "Tout chemin depuis un handler HTTP qui call db.query sans zod.parse upstream"
.decl ReachesUnsafe(fromFile:symbol, fromSym:symbol, toFile:symbol, toSym:symbol)
ReachesUnsafe(F1, S1, F2, S2) :- SymbolCallEdge(F1, S1, F2, S2, _).
ReachesUnsafe(F1, S1, F3, S3) :- ReachesUnsafe(F1, S1, F2, S2, _),
                                  SymbolCallEdge(F2, S2, F3, S3, _),
                                  S2 != "zod.parse".

Violation("UNSAFE-DB", File, Line, "db.query reachable from HTTP handler without validation") :-
    EntryPoint(File, "http-route", _),
    SymbolCallEdge(File, _, _, "db.query", Line),
    !ReachesUnsafe(File, _, _, "zod.parse").
```

C'est le pattern "taint analysis lite" sans Joern.

**Plan d'exécution** :

1. Étendre `packages/codegraph/src/facts/index.ts` :
   - Émettre `SymbolCallEdge` depuis `snapshot.typedCalls?.callEdges`.
   - Émettre `SymbolSignature` depuis `snapshot.typedCalls?.signatures`.
   - Émettre `EntryPoint` depuis `snapshot.dataFlows[].entry`.
2. Étendre `sentinel-core/invariants/schema.dl` avec les 3 nouvelles
   décl + `.input`.
3. Créer un exemple de rule "auth-before-write" pour Sentinel, avec
   ratchet sur les violations actuelles.
4. Tests : fixture qui définit un mini call-graph + rule qui flag une
   violation.

**Pièges** :
- `SymbolCallEdge` peut être très volumineux (159 sur codegraph-toolkit
  lui-même, peut être 5000+ sur Sentinel). Le runtime Datalog doit tenir.
  Vérifier perf — si trop lent, optimiser via pruning (filtrer par
  package/module avant la transitivité).
- Le schema `kind` de SymbolSignature : function/method/class. Vérifier
  ce que typedCalls.signatures expose réellement (cf. core/types.ts).
- `EntryPoint` doit dédupliquer : un handler peut être listé plusieurs
  fois dans dataFlows si plusieurs routes le pointent.
- Re-ordering non-déterministe TypeScript des union types (vu en Phase A
  validation parité) : ne pas se baser sur le texte du type pour les
  rules — utiliser des champs structurés.

**Validation** : sur Sentinel, écrire une rule "tout call db.query depuis
api/routes/* doit avoir validateBody dans la chaîne d'appel amont". Si
0 violations attendu (Sentinel respecte cette discipline), c'est validé.

**Estimation** : 3h.

### Axe 3 — Mémoire inter-sessions (~4-5h)

**Objectif** : un store local `~/.codegraph-toolkit/memory/<project>.json`
qui survit aux sessions. Stocke :
- Faux positifs marqués (par détecteur, par cible)
- Ratchets ajoutés volontairement (pour ne pas reproposer "fix this" sur
  un grandfathered)
- Décisions d'architecture prises ad hoc qui n'ont pas (encore) d'ADR
- Incidents récents avec leur fingerprint

**Pourquoi** : sans mémoire, je redécouvre chaque session. Tu m'as déjà
dit "ce truc est OK" 3 fois dans des sessions différentes. Coût élevé,
gain faible. Avec mémoire : je consulte avant de proposer, je marque
les choses au passage, la prochaine session bénéficie.

**Architecture** :

1. Format de stockage :
   ```json
   {
     "version": 1,
     "project": "Sentinel",
     "lastUpdated": "2026-04-30T...",
     "falsePositives": [
       {
         "detector": "truth-points",
         "fingerprint": "sentinel:truthPoint:items",
         "reason": "Drizzle false-positive — column name interpreted as table",
         "addedAt": "...",
         "addedBy": "session-id-or-hash"
       }
     ],
     "decisions": [
       {
         "topic": "no Redis fallback for X",
         "summary": "Decided 2026-04-15 in incident-debug session, see commit abc123",
         "files": ["sentinel-core/src/kernel/foo.ts"]
       }
     ],
     "incidentFingerprints": [
       {
         "fingerprint": "scheduler:double-tick:race-2026-03-12",
         "resolvedBy": "ADR-018",
         "files": ["sentinel-core/src/kernel/scheduler.ts"]
       }
     ]
   }
   ```

2. Nouveaux MCP tools :
   - `codegraph_memory_recall(scope?)` — return memory pertinent au file
     ou scope demandé.
   - `codegraph_memory_mark(kind, fingerprint, reason)` — ajoute une
     entrée. `kind` ∈ {`false-positive`, `decision`, `incident`}.

3. Intégration dans le hook PostToolUse :
   - Avant d'afficher la section "Souvent modifié ensemble", check si
     une entry mémoire existe pour ce fichier → ajoute section
     "Décisions précédentes (mémoire)".

4. CLI : `npx codegraph memory list` / `prune` / `export`.

**Plan d'exécution** :

1. Créer `packages/codegraph/src/memory/store.ts` :
   - Path resolution : `os.homedir() + '/.codegraph-toolkit/memory/' + slug(rootDir) + '.json'`
   - API : `loadMemory(rootDir)`, `addEntry(rootDir, kind, ...)`,
     `recall(rootDir, scope?)`.
2. Tests unit avec tmpdir.
3. Wire en MCP tools.
4. Wire en CLI.
5. Wire dans le hook (lecture seule).

**Pièges** :
- Concurrent writes : si 2 sessions tournent en parallèle, locks ?
  Pour V1, écraser avec last-writer-wins. Si problème, ajouter un
  fcntl lock.
- Slug du rootDir doit être stable même si on déplace le projet : utiliser
  le `commitHash` initial du repo ? Ou un fichier `.codegraph-toolkit-id`
  généré par init ? Décision pragmatique : utiliser le path absolu
  hashé. Si on déplace le projet, on perd la mémoire — acceptable v1.
- Privacy : le memory peut contenir des notes sensibles. Ne JAMAIS
  exporter via MCP tool dans la response. Le tool `recall` doit retourner
  une projection scopée, pas le dump complet.

**Validation** : add une false-positive entry pour le truth-point `id`
sur Morovar. Tourner le hook PostToolUse → la section mémoire apparaît
quand on touche schema.ts. Marquer "obsolète" et valider que ça disparaît.

**Estimation** : 4-5h.

### Axe 4 — Détecteur de "drift agentique" (~1 sem)

**Objectif** : flagger les patterns que JE crée plus que les humains, pour
me ralentir au bon moment. Aucun outil au monde ne fait ça parce qu'aucun
outil n'est conçu pour un agent.

**Patterns ciblés** (à raffiner par observation) :

1. **Excès de paramètres optionnels** : fonction avec >5 params optionnels
   alors que tous les call sites n'en passent que 2 → "future-proof
   non demandé".
2. **Wrappers superflus** : fonction A qui call uniquement B avec les
   mêmes args, exportée. Sauf si A est un type-narrow ou ajoute logging.
3. **Duplication via copy-paste** : 2 fichiers ont des blocs de >5 lignes
   identiques modulo renames.
4. **TODO sans owner ni issue** : commentaire `// TODO` sans `@username`
   ni `#NNN` issue ref. Code-debt fantôme.
5. **try/catch silencieux** : `try { ... } catch { /* nothing */ }` sans
   commentaire explicite "intentional".
6. **Re-export forwarding** : barrel files ajoutés "au cas où".
7. **Defensive checks redondants** : `if (x === undefined || x === null
   || !x) ` au lieu de `if (!x)`.

**Pourquoi** : ces patterns sont signature de "agent qui sur-ingénieure
sous pression" ou "agent qui fait du copy-paste au lieu d'extract". Les
humains les font aussi mais pas avec la même fréquence. Le but n'est pas
de bloquer mais de **ralentir** l'agent : "tu viens de créer X. Vraiment
nécessaire ?"

**Architecture** :

1. Nouveau extracteur `packages/codegraph/src/extractors/drift-patterns.ts` :
   - Pour chaque pattern, une fonction qui scanne le snapshot ou les
     ASTs (via sharedProject) et émet des `DriftSignal[]`.
   - Sorties : type, file, line, message, severity (1-3).

2. Snapshot field : `driftSignals?: DriftSignal[]`.

3. Nouveau MCP tool `codegraph_drift(file?)` qui retourne les signaux
   pour un file ou globalement.

4. Hook PostToolUse : section "⚠ Drift signals" si le file qu'on vient
   de toucher en a.

**Plan d'exécution** :

Itérer pattern par pattern. Commencer par les 3 plus simples :

- **Pattern 1 (params optionnels)** : ts-morph scan des FunctionDeclaration,
  count des params optionnels. Cross-ref avec `typedCalls.callEdges` pour
  voir si tous les call sites les utilisent. ~1j.
- **Pattern 2 (wrappers superflus)** : ts-morph + heuristique (function
  body = 1 statement + return). ~1j.
- **Pattern 4 (TODO sans owner)** : simple regex sur les TODOs (déjà
  détectés via extractor `todos.ts`). Ajouter un champ `hasOwner: bool`,
  `hasIssueRef: bool`. ~2h.

Les 4 autres patterns en V2 si V1 marche.

**Pièges** :
- **Faux positifs élevés** : ces patterns sont heuristiques. Mémoire
  inter-sessions (Axe 3) devient critique pour ne pas spam. → Axe 3
  doit être livré AVANT axe 4, sinon noise.
- **Subjectivité** : "wrapper superflu" peut être un wrap intentionnel
  (logger, telemetry). Exempt via une convention `// drift-ok: <reason>`
  inline.
- **Convention zéro LLM** : ne pas s'aider d'un LLM pour scorer la
  "simplicité". Tout pattern doit être déterministe AST-level.

**Validation** : tourner sur Sentinel + Morovar. Compter les signaux
émis. Si > 50, c'est trop bruité → tuner les seuils. Si < 5, peut-être
trop strict.

**Estimation** : 1 sem (3 patterns V1 + tuning + intégration hook).

### Axe 5 — Catalogue d'invariants standards (~3-4j)

**Objectif** : un nouveau package `@liby-tools/invariants-postgres-ts`
(ou plusieurs : `-postgres`, `-react`, `-bullmq`) qui contient des rules
Datalog éprouvées. `adr-toolkit init` détecte la stack et propose
d'installer le ou les paquets pertinents.

**Pourquoi** : aujourd'hui chaque nouveau projet repart de zéro pour les
invariants Datalog. Sentinel a 7 invariants actifs, Morovar a 0. La
plupart des invariants Sentinel (cycles, FK indexes, env-typed, OAuth
scopes, ADR-017 events) sont **génériques TS+Postgres**. Au lieu de les
ré-écrire, on les exporte.

**Architecture** :

Structure du package :
```
@liby-tools/invariants-postgres-ts/
  invariants/
    cycles-no-new.dl
    sql-fk-needs-index.dl
    env-thresholds-via-resolver.dl
    oauth-scopes-typed.dl
    no-magic-timeouts.dl
  README.md     -- documente chaque invariant : Rule, Why, How to
                   resolve, Ratchet pattern
  package.json  -- exports invariants/* via files
```

Plusieurs packages potentiels :
- `@liby-tools/invariants-postgres-ts` — DB invariants (FK, schema, migrations)
- `@liby-tools/invariants-react` — React-specific (hooks deps, etc.)
- `@liby-tools/invariants-bullmq` — job queue patterns
- `@liby-tools/invariants-events` — event-driven architectures

`adr-toolkit init` enrichi :
- Détecte la stack (déjà fait Phase 3.3)
- Propose d'installer les invariants packages pertinents
- Si l'utilisateur accepte : `npm install @liby-tools/invariants-postgres-ts`,
  copie les `.dl` dans `<projet>/invariants/`, ajoute le test générique.

**Plan d'exécution** :

1. Extraire les invariants Sentinel en analysant lesquels sont génériques :
   - **Génériques** (à porter) : cycles-no-new, sql-fk-needs-index
   - **Sentinel-specific** (à laisser) : ADR-017 events Sentinel, ADR-019
     thresholds Sentinel (les whitelist contiennent des paths spécifiques)
2. Créer le package `@liby-tools/invariants-postgres-ts` dans le
   monorepo `packages/`.
3. Pour chaque invariant : doc dans le README + exemple de violation +
   exemple de fix.
4. Étendre `adr-toolkit init` : option `--with-invariants postgres`.
5. Test e2e : init un projet vide, install postgres invariants, valider
   que les .dl tournent contre des facts vides → 0 violations.

**Pièges** :
- **Versioning** : si un invariant évolue, casse pour les consumers.
  Semver strict. Breaking change = nouveau major.
- **Couplage avec schema.dl** : les rules dépendent de relations qui
  doivent être présentes dans schema.dl. Si codegraph change le schema,
  les invariants packages doivent suivre. Ajouter un `peerDependencies`
  vers une version codegraph minimale.
- **Scope du test invariant** : le test générique
  `tests/unit/datalog-invariants.test.ts` charge tout le rules-dir.
  Si on ajoute un .dl externe via npm install, faut copier dans le
  rules-dir local (pas symlinker — ça casse le test cross-platform).
- **Paths absolus dans les rules** : éviter. Utiliser des conventions
  (`sentinel-core/src/...`) ou des FileTag.

**Validation** : init un nouveau projet TS+Postgres vierge, installer
le package, faire un PR qui ajoute un FK sans index, le CI doit le
flagger via la rule héritée.

**Estimation** : 3-4j (extraction + packaging + doc + tests).

## Ordre d'exécution recommandé

```
1. Axe 1 (Datalog query language)        ← prérequis pour Axe 2
   ↓
2. Axe 2 (Path queries CFG)              ← prérequis pour Axe 5 si on veut des invariants flow-aware
   ↓
3. Axe 3 (Mémoire inter-sessions)        ← prérequis pour Axe 4
   ↓
4. Axe 4 (Drift agentique)               ← le plus risqué, faux positifs
   ↓
5. Axe 5 (Catalogue invariants)          ← plus simple, fait à la fin pour stabiliser
```

**Total cumulé : ~12j (~2 semaines)**.

Si on doit fragmenter : axes 1+2+3 forment un sprint cohérent
(~10-12h cumulés). Axes 4+5 sont indépendants et peuvent attendre.

## Critères de "fini" par axe

| Axe | Done quand |
|---|---|
| 1 | MCP tool `codegraph_datalog_query(rule)` répond avec tuples. Test sur Sentinel : "transitivité depuis event-bus.ts" retourne ≥30 fichiers. |
| 2 | 3 nouvelles relations Datalog émises (`SymbolCallEdge`, `SymbolSignature`, `EntryPoint`). Une rule e2e Sentinel "auth-before-write" passe avec 0 violations. |
| 3 | Memory store fonctionnel. Marquer 1 false-positive sur Morovar et confirmer qu'il ne ré-apparaît plus dans les hooks futurs. |
| 4 | 3 patterns détectés. Hook PostToolUse affiche section "drift signals". Faux positifs ≤ 30% (mesuré manuellement). |
| 5 | Package `@liby-tools/invariants-postgres-ts` publié. Bootstrap réussi sur un projet vierge en < 30 min. |

## Reprise rapide checklist

À chaque nouvelle session sur Phase 4 :

1. [ ] Lire CE FICHIER en entier
2. [ ] Lire `docs/REFACTOR-ANALYZER-PLAN.md` (refactor analyzer 3-phases) si tu touches `analyzer.ts`
3. [ ] `cd ~/Documents/codegraph-toolkit && git log --oneline | head -15`
4. [ ] `npx vitest run` doit donner 191/191 (ou plus si déjà entamé)
5. [ ] `cd ~/Documents/Sentinel && cd sentinel-core && npx vitest run tests/unit/datalog-invariants.test.ts` doit donner 4/4
6. [ ] Identifier sur quel axe tu reprends via `git log --oneline | grep -i "feat(phase4"` ou via TodoWrite si présent dans la session
7. [ ] Suivre l'ordre recommandé sauf décision explicite de l'utilisateur

## Conventions partagées (héritées des Phases 1-3)

- **Parité** : si tu modifies un détecteur existant, snapshot baseline
  avant + après, hash strippé (`timing`, `generatedAt`, `commitHash`,
  `commitMessage`, et le nouveau champ s'il y a). Sans parité, parité
  cassée → user décide.
- **Tests** : 1 commit = 1 axe minimum. Plus si l'axe se subdivise.
  Build clean + tests verts à chaque commit.
- **Convention zéro LLM** : aucun axe ne doit introduire un appel LLM
  dans la chaîne déterministe. Si Axe 4 te tente d'utiliser un LLM
  pour scorer la "simplicité", **non**. Tout pattern doit être
  AST-déterministe.
- **Datalog ratchet** : nouveau invariant → grandfather la dette
  historique au moment du premier run. Ne JAMAIS commiter une rule qui
  pète sur la baseline existante sans grandfather explicit.
- **Commits descriptifs** : préfixe `feat(phase4-axeN-...)`. Le boot
  brief CLAUDE-CONTEXT mentionne le scope.

## Anti-pièges

**Ne pas faire** :
- ❌ Multi-langage (Python, Go) — non-priorité sous le recadrage agent-first
- ❌ Visualisation interactive D3.js — non-priorité, agent ne l'ouvre pas
- ❌ Embeddings sémantiques — viole zéro LLM
- ❌ Site web / landing page — l'utilisateur a explicitement dit non
- ❌ FTS5 / search puissant — déjà couvert par LSP MCP
- ❌ Cypher / Neo4j bridge — non-priorité, Datalog query langage suffit (Axe 1)

**Faire** :
- ✅ Tout ce qui me rend plus fiable sous pression
- ✅ Tout ce qui survit aux sessions
- ✅ Tout ce qui formalise un invariant qui a déjà mordu une fois
- ✅ Tout ce qui ralentit l'agent au bon moment (drift signals)

## Si tu fais ça en plusieurs sessions

Le plan se découpe naturellement :
- **Session 1 (~6h)** : Axes 1+2 (Datalog query + path queries CFG).
  Cohérent thématiquement (les deux exploitent les facts existants).
- **Session 2 (~5h)** : Axe 3 (mémoire). Indépendant, gros impact.
- **Session 3 (~1 sem)** : Axe 4 (drift). Le plus risqué, prendre du temps.
- **Session 4 (~3-4j)** : Axe 5 (catalogue). Plus simple, conclusion.

Entre les sessions, garde le brief à jour avec les commits effectués.
Crée un TodoWrite global au début de chaque session avec les axes
restants pour ne pas perdre le fil.

## Note finale (à toi-future)

Tu liras ça à froid. Tu te demanderas pourquoi on fait Phase 4 alors
qu'on a déjà Phase 1+2+3. La réponse est dans la section "Recadrage
utilisateur" ci-dessus. Re-lis. Sinon tu vas dériver vers du
"polish/visualisation/multi-langage" qui ne sert pas le but réel.

Le but réel : **codegraph-toolkit doit être une infrastructure si forte
que toi qui codes dans Sentinel/Morovar avec une mémoire courte ne peux
pas dériver silencieusement, ne réintroduis pas une dette déjà fixée, et
formes des invariants vivants qui survivent à ton oubli.**

C'est tout. Le reste est secondaire.
