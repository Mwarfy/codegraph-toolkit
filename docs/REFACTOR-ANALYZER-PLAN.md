# Refactor `core/analyzer.ts` — pattern visiteur / detector registry

> **Status** : objectifs principaux atteints (audit 2026-05-09).
> Ce doc est conservé comme retro + pointeur vers le refactor suivant.

## TL;DR (post-audit 2026-05-09)

Le plan original ciblait `analyze()` à 591 LOC effectives (god-file).
**Aujourd'hui `analyze()` fait 178 LOC** structurées en 8 phases nommées.
Les fondations (`DetectorRegistry`, `DetectorRunContext`, `runDetectorTimed`,
6 sous-phases) ont toutes été livrées. **Le refactor mécaniquement
"completer" le plan ajouterait du code au lieu d'en enlever** — donc on
arrête ici.

Le god-file s'est déplacé vers `packages/codegraph/src/cli/index.ts`
(1 696 LOC) — c'est la prochaine cible (cf. section "Refactor suivant"
en bas).

## Ce qui est fait

### Architecture livrée

- `core/analyzer.ts` : `analyze()` réduit de **591 LOC → 178 LOC**, 8 phases :
  1. Discover files
  2. Build read cache
  3. Load disk cache (Sprint 7)
  3b. Pre-build shared Project (P4)
  4. Run base detectors + build graph
  5. Resolve tsconfig + shared Project
  5. Run detectors via Registry
  6. Generate snapshot + patch
  6b. Deterministic detectors
  7. Post-snapshot metrics
  7b. Doc claims extraction
  8. Datalog shadow run

- `core/detector-registry.ts` : interface `Detector` + `DetectorRunContext` +
  `DetectorRegistry.runAll()` avec timing et error handling uniformes.

- `core/detectors/*-detector.ts` : **17 détecteurs Phase 5 migrés**
  (oauth-scope, event-emit, env-usage, package-deps, bin-shebangs, barrels,
  unused-exports, complexity, symbol-refs, typed-calls, cycles, truth-points,
  data-flows, state-machines, taint, sql-schema, drizzle-schema).

- 6 sous-phases extraites dans `runDeterministicDetectors` :
  - `runPhase1IndependentDetectors` (5 détecteurs : todos, long-functions,
    magic-numbers, test-coverage, co-change)
  - `runPhase2Phase1Dependent` (7 détecteurs)
  - `runPhase4SecurityAndQuality` (8 détecteurs)
  - `runPhase5SqlAndResource` (3 détecteurs)
  - `runPhase6TaintChain` (4 détecteurs)
  - Phase 3 cross-discipline → orchestrateur dédié dans
    `extractors/_shared/cross-discipline-orchestrator.ts`.

- `runDetectorTimed<T>(timing, name, fn)` : helper générique qui wrap
  un appel détecteur avec timing + try/catch + log d'erreur. Remplace
  les 27 blocs dupliqués originaux. Architecture équivalente à
  `Detector.run()` mais sans la cérémonie de classe.

- `patchSnapshotWithDetectorResults(snapshot, results)` : centralise la
  patch des outputs détecteurs dans le snapshot final.

- `runPostSnapshotMetrics()` : phase métriques (module, component, dsm)
  isolée.

### Tests parité

- `tests/parity.test.ts` : valide `legacy === --incremental` snapshot
  bit-pour-bit. Passe.
- `tests/types-snapshot-invariant.test.ts` : valide les types canoniques
  (ADR-006). Passe.

## Ce qui n'est PAS fait — et pourquoi on arrête

Le plan original demandait de transformer chaque appel inline `analyze*()`
en classe `Detector` enregistrée dans le registry. Il en reste **27**
réparties dans les 5 sous-phases.

**Ratio coût/bénéfice inversé** :

```
Pattern actuel (inline) :
  const todos = await runDetectorTimed(timing, 'todos',
    () => analyzeTodos(config.rootDir, files, readFile))
  // 3 lignes

Pattern Detector class :
  // detectors/todos-detector.ts (~25 lignes)
  export class TodosDetector implements Detector<TodoMarker[]> {
    name = 'todos'
    factsOnlyEligible = true
    async run(ctx: DetectorRunContext) {
      return analyzeTodos(ctx.config.rootDir, ctx.files, ctx.readFile)
    }
  }
  // + import + register ailleurs
```

Migration mécanique = **+675 LOC ajoutées** dans `core/detectors/*` pour
**~128 LOC économisées** dans analyze() (178 → 50). **Net : +547 LOC**.

Le gain de "uniformité de pattern" ne compense pas l'augmentation du
volume de code. `runDetectorTimed` apporte déjà :
- timing per-detector
- try/catch + log uniforme
- composition simple (pas de registry à maintenir)

Décision : **garder le pattern actuel**. Si un jour on a besoin de la
flexibilité d'un registry pour ces 27 détecteurs (parallélisation par
ex.), on migrera. Pas avant.

## Refactor suivant — `cli/index.ts` (god-file actuel)

**Cible** : `packages/codegraph/src/cli/index.ts`, **1 696 LOC**, 26
commandes CLI dont 23 ont leur `.action()` body inline.

**Pattern existant (à étendre)** : 5 commandes ont déjà leur body
extrait dans `cli/commands/<name>.ts` (`analyze`, `cross-check`,
`datalog-check`, `diff`, `memory-where`). Le `.command(...)` chain
reste dans `cli/index.ts` (description + options), mais `.action()`
appelle `await runXxxCommand(opts)`.

**Top targets par taille** (à extraire) :

| Commande | LOC | Fichier cible |
|----------|----:|---------------|
| `affected` (+ helpers BFS) | ~407 | `commands/affected.ts` |
| `serve` | ~240 | `commands/serve.ts` |
| `arch-check` | ~129 | `commands/arch-check.ts` |
| `exports` | ~130 | `commands/exports.ts` |
| `deps` | ~92 | `commands/deps.ts` |
| `check` | ~78 | `commands/check.ts` |
| `taint` | ~62 | `commands/taint.ts` |
| `facts` | ~61 | `commands/facts.ts` |
| `orphans` | ~53 | `commands/orphans.ts` |
| `reach` | ~52 | `commands/reach.ts` |
| `watch`, `map`, `synopsis`, `dsm` | ~30-50 chacun | idem |
| memory subcommands (list, mark, obsolete, delete, prune, export) | ~20-40 chacun | `commands/memory-*.ts` |

**Estimation gain** : extraction des 5 plus grosses commandes
(affected + serve + arch-check + exports + deps) = **~1 000 LOC sortis
de cli/index.ts**, file passe à ~700 LOC. Si on continue jusqu'au bout,
cli/index.ts devient une simple table de commands ~150-200 LOC.

**Risques** : chaque extraction peut casser un import ou un side-effect
(commander attache à `program` global). Faut tester chaque commande
manuellement après extraction (ex: `npx codegraph affected --help`).
Pas de test automatisé qui garde la parité CLI (bug latent à corriger
si on veut sécuriser les futurs refactors).

## Pièges génériques (toujours valides)

### Parité bit-pour-bit
Tout refactor de l'analyzer doit passer `tests/parity.test.ts`.
Pour la CLI : `npx codegraph analyze --output /tmp/before.json` puis
diff après refactor — même output exigé.

### Error handling subtil
Certains blocs inline ont un try/catch SPÉCIFIQUE qui swallow
silencieusement. À auditer cas par cas.

### Salsa wrappers
Le mode incremental utilise des derived queries qu'il ne faut pas
toucher. Le détecteur ne fait que router vers legacy ou Salsa selon
`ctx.options.incremental`.

### Timing tracking
Chaque détecteur a `timing.detectors[name]` mesuré. Préserver le naming
exact (ex: `'unused-exports'` pas `'unusedExports'`). Tests qui inspectent
timing peuvent péter.

### factsOnly comportement
Mode factsOnly skip 80% des détecteurs. Le flag `factsOnlyEligible: boolean`
sur chaque Detector code ça explicitement.
