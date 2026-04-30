# Refactor `core/analyzer.ts` — pattern visiteur / detector registry

> **Pour Claude qui reprend dans une nouvelle session :** lis CE FICHIER
> EN ENTIER avant toute action. C'est un refactor RISQUÉ — la parité
> snapshot bit-pour-bit est critique. Les tests `parity.test.ts` doivent
> passer après chaque étape.

## Contexte

`packages/codegraph/src/core/analyzer.ts` est le god-file du toolkit :
- **1188 LOC** total
- Fonction `analyze()` : **855 lignes brutes / 591 LOC effectives**
- **46 imports** au top
- 4 exports
- Orchestrateur séquentiel de 15+ blocs détecteurs

**État actuel** (post Sprint avril 2026) :
- 2 sections déjà extraites en helpers privés :
  - `prebuildSharedProjectIncremental(config, files, fileCache)` — section 3b
  - `runDeterministicDetectors(config, files, readFile, sharedProject, snapshot, timing)` — section 6b
- analyze() reste un god-file mais avec ces 2 helpers extraits, il est
  plus lisible (-100 LOC effectives).

## Pourquoi refactor

**Maintenabilité long terme** :
- Ajouter un nouveau détecteur demande de toucher analyze() qui est
  déjà le hot path.
- Tests cross-détecteurs difficiles (chaque détecteur est inline dans
  l'orchestrateur).
- Cognitive load : lire analyze() complet pour comprendre le pipeline
  est onéreux.

**Pattern naturellement émergent** :
- Tous les blocs suivent le même squelette :
  ```
  const tXxx = performance.now()
  if (!factsOnly) try {
    result = incremental ? incAllXxx.get('all') : await analyzeXxx(...)
    // patch into snapshot/graph
    timing.detectors['xxx'] = performance.now() - tXxx
  } catch (err) {
    timing.detectors['xxx'] = performance.now() - tXxx
    console.error(`  ✗ xxx failed: ${err}`)
  }
  ```
- C'est un pattern visiteur déguisé. L'abstraction est attendue.

## Architecture cible

### Type `AnalysisContext`

Carrier object qui porte tout l'état partagé entre détecteurs :

```ts
// packages/codegraph/src/core/analysis-context.ts (nouveau fichier)

export interface AnalysisContext {
  // Inputs
  config: CodeGraphConfig
  options: AnalyzeOptions
  files: string[]
  readFile: (relPath: string) => Promise<string>
  fileCache: Map<string, string>

  // Resolved
  tsConfigPath: string | undefined
  sharedProject: Project  // ts-morph Project, prebuilt en mode incremental

  // Outputs (mutated by detectors)
  graph: CodeGraph
  snapshot: GraphSnapshot
  timing: AnalyzeResult['timing']
}
```

### Interface `Detector`

Tout détecteur implémente ce contract :

```ts
// packages/codegraph/src/core/detector-registry.ts (nouveau fichier)

export interface Detector {
  /** Nom unique pour timing tracking et debug. */
  name: string

  /**
   * Si true, le détecteur tourne aussi en mode factsOnly (pour les
   * facts Datalog). Sinon, skip en factsOnly.
   */
  factsOnlyEligible: boolean

  /**
   * Détecteurs prerequisites — exécutés AVANT celui-ci. Permet de
   * déclarer des dépendances (typedCalls avant dataFlows, etc.).
   */
  dependsOn?: string[]

  /**
   * Run le détecteur. Mutate ctx.snapshot / ctx.graph.
   * Le orchestrateur gère timing + error handling.
   */
  run(ctx: AnalysisContext): Promise<void>
}

export class DetectorRegistry {
  private detectors: Detector[] = []

  register(d: Detector): void { this.detectors.push(d) }

  /**
   * Trie topologiquement par dependsOn et exécute. Timing + errors
   * gérés ici.
   */
  async runAll(ctx: AnalysisContext): Promise<void> {
    const sorted = topologicalSort(this.detectors)
    for (const d of sorted) {
      if (ctx.options.factsOnly && !d.factsOnlyEligible) continue
      const t0 = performance.now()
      try {
        await d.run(ctx)
        ctx.timing.detectors[d.name] = performance.now() - t0
      } catch (err) {
        ctx.timing.detectors[d.name] = performance.now() - t0
        console.error(`  ✗ ${d.name} failed: ${err}`)
      }
    }
  }
}
```

### Détecteurs concrets

Chaque section actuelle de analyze() devient un Detector :

```ts
// packages/codegraph/src/core/detectors/unused-exports-detector.ts

export class UnusedExportsDetector implements Detector {
  name = 'unused-exports'
  factsOnlyEligible = false  // skip en factsOnly

  async run(ctx: AnalysisContext) {
    const exportInfos = ctx.options.incremental
      ? incAllUnusedExports.get('all')
      : await analyzeExports(ctx.config.rootDir, ctx.files, ctx.tsConfigPath, ctx.sharedProject)

    for (const info of exportInfos) {
      const node = ctx.graph.getNodeById(info.file)
      if (node) {
        ctx.graph.setNodeExports(info.file, info.exports, info.totalCount)
      }
    }
  }
}
```

Idem pour `ComplexityDetector`, `SymbolRefsDetector`, `TypedCallsDetector`,
`CyclesDetector`, `TruthPointsDetector`, `DataFlowsDetector`, etc.

### `analyze()` simplifié

```ts
export async function analyze(
  config: CodeGraphConfig,
  options: AnalyzeOptions = {},
): Promise<AnalyzeResult> {
  const ctx = await buildAnalysisContext(config, options)

  // Phase 1 : graph build (légacy, pas un Detector)
  await buildGraphPhase(ctx)

  // Phase 2 : run all registered detectors
  const registry = createDefaultRegistry()
  await registry.runAll(ctx)

  // Phase 3 : metrics + persistence
  await runMetricsPhase(ctx)
  await persistenceSavePhase(ctx)

  return { snapshot: ctx.snapshot, timing: ctx.timing }
}

function createDefaultRegistry(): DetectorRegistry {
  const reg = new DetectorRegistry()
  reg.register(new UnusedExportsDetector())
  reg.register(new ComplexityDetector())
  reg.register(new SymbolRefsDetector())
  reg.register(new TypedCallsDetector())
  reg.register(new CyclesDetector())
  reg.register(new TruthPointsDetector({ dependsOn: ['typed-calls'] }))
  reg.register(new DataFlowsDetector({ dependsOn: ['typed-calls', 'truth-points'] }))
  // ...
  return reg
}
```

## Pièges critiques

### Piège 1 — Ordre des détecteurs

Beaucoup de blocs ont des dépendances cachées :
- `data-flows` lit `typedCalls` (déjà calculé avant)
- `truth-points` lit `graphEdges` set par les blocs précédents
- `module-metrics` lit `snapshot.edges` final

Si on permute l'ordre, output change. Le `dependsOn` doit être déclaré
avec précision. **Mapping actuel à reverse-engineer dans analyze()** :

```
event-emit-sites    → no dep (pure scan)
oauth-scope-literals→ no dep
ts-imports          → graph.addEdge — utilisé par tous les autres
unused-exports      → sharedProject seulement
complexity          → sharedProject
symbol-refs         → sharedProject + symbolRefs reads
typed-calls         → sharedProject
cycles              → graph.edges (post ts-imports)
truth-points        → typed-calls + graphEdges
data-flows          → typed-calls + truth-points
state-machines      → SQL files + sharedProject
env-usage           → sharedProject
package-deps        → manifests (lus async)
barrels             → sharedProject
taint               → sharedProject + rules
module-metrics      → snapshot final (post graph build)
component-metrics   → snapshot final
dsm                 → snapshot final
```

À documenter dans chaque Detector.

### Piège 2 — Parité bit-pour-bit

`tests/parity.test.ts` valide que le snapshot legacy === --incremental.
Tout refactor doit passer ce test. Approche :

1. Avant refactor : prendre snapshot Sentinel actuel `npx codegraph
   analyze --output /tmp/before.json`
2. Refactor (par étape, commit fréquents)
3. Après refactor : `npx codegraph analyze --output /tmp/after.json`
4. `diff /tmp/before.json /tmp/after.json` doit être vide

Aussi : les tests `incremental.test.ts` qui vérifient la parité Salsa
doivent continuer à passer. Le refactor ne doit toucher que le mode
legacy (Salsa wrappers existants restent inchangés).

### Piège 3 — Error handling subtil

Dans analyze() actuel, certains blocs ont un try/catch SPÉCIFIQUE :
```ts
try {
  taintViolations = await analyzeTaint(...)
} catch (err) {
  // certains errors sont swallow, d'autres remontent
}
```

Pas tous les blocs sont symétriques. À auditer cas par cas avant
d'abstraire en `runDetector()` générique. Risque : changer
silencieusement le comportement d'un détecteur sur erreur.

### Piège 4 — Timing tracking

Chaque détecteur a `timing.detectors[name]` mesuré. Le wrapper
`runAll()` doit préserver le naming exact (ex: `'unused-exports'` pas
`'unusedExports'`). Tests qui inspectent timing peuvent péter.

### Piège 5 — factsOnly comportement

Mode factsOnly skip 80% des détecteurs. Le flag `factsOnlyEligible: boolean`
sur chaque Detector code ça explicitement. Vérifier que la liste des
détecteurs factsOnly-eligible matche EXACTEMENT le comportement actuel :
- ✅ event-emit-sites
- ✅ env-usage
- ✅ oauth-scope-literals
- ✅ module-metrics
- ✅ ts-imports / event-bus / http-routes / bullmq-queues / db-tables (base detectors via createDetectors registry — déjà gérés ailleurs)
- ❌ unused-exports / complexity / symbol-refs / typed-calls / cycles /
  truth-points / data-flows / state-machines / package-deps / barrels /
  taint / component-metrics / dsm / todos / long-functions /
  magic-numbers / test-coverage

## Plan d'attaque pas-à-pas

### Étape 0 — Snapshot baseline (15min)

```bash
cd ~/Documents/Sentinel
codegraph analyze --output /tmp/snapshot-before-refactor.json
# Save it. C'est le golden snapshot pour la parité.
```

### Étape 1 — Extract AnalysisContext + buildAnalysisContext (1h)

Créer `core/analysis-context.ts`. Refactor analyze() pour construire
AnalysisContext en début puis mutate via les sections existantes.
Snapshot toujours identique au baseline.

Test après : run analyze sur Sentinel, diff vs baseline. Doit être 0.

### Étape 2 — Extract DetectorRegistry skeleton (1h)

Créer `core/detector-registry.ts`. Pas encore de Detector concret —
juste l'interface + classe. analyze() reste inchangé.

Build clean.

### Étape 3 — Migrer 1 détecteur simple (30min) — `EventEmitSitesDetector`

Choisir le plus simple (pas de dépendances inter-détecteurs). Convertir
la section actuelle en Detector class. Register dans analyze() AVANT
le code legacy de cette section. Vérifier que ça produit le même
résultat. Supprimer le code legacy.

Test parité bit-pour-bit.

### Étape 4 — Migrer les autres détecteurs un par un (4-6h)

Dans l'ordre suggéré (par complexité croissante) :
1. ✅ event-emit-sites (étape 3)
2. env-usage
3. oauth-scope-literals
4. package-deps
5. barrels
6. unused-exports
7. complexity
8. symbol-refs
9. typed-calls
10. cycles
11. truth-points
12. state-machines
13. data-flows
14. taint

Pour chaque migration : commit séparé + tests parité passants.

### Étape 5 — Migrer les phases hors-Detector (2h)

Module-metrics, component-metrics, dsm tournent APRÈS le snapshot
build. Garder en `runMetricsPhase(ctx)` séparé OU les Detector-iser
aussi avec `dependsOn: ['snapshot-built']`.

Décision pragmatique : garder en phase séparée pour v1. Refactor
ultérieur si besoin.

### Étape 6 — Cleanup analyze() (30min)

Une fois tous les détecteurs migrés, analyze() devrait être ~50-80
LOC :

```ts
export async function analyze(config, options = {}): Promise<AnalyzeResult> {
  const ctx = await buildAnalysisContext(config, options)
  await buildGraphPhase(ctx)
  await createDefaultRegistry().runAll(ctx)
  await runMetricsPhase(ctx)
  await persistenceSavePhase(ctx)
  return { snapshot: ctx.snapshot, timing: ctx.timing }
}
```

### Étape 7 — Tests + commit final (30min)

- 108/108 tests toolkit passent
- parity.test.ts passent
- Sentinel snapshot == baseline
- Commit avec mesures :
  ```
  refactor(codegraph): pattern visiteur / detector registry pour analyze()
  
  -1100 LOC dans analyze() (591 → 50 LOC)
  +250 LOC dans detectors/* (15 nouveaux fichiers, 1 par détecteur)
  +100 LOC core/detector-registry.ts + analysis-context.ts
  
  Net : ~-750 LOC, distribution claire, tests parité 100%.
  ```

## Estimation effort

**1-2 jours dédiés** (pas en mode auto cumulatif sur plusieurs sessions
courtes — le contexte cross-section est trop important pour fragmenter
sainement).

Breakdown :
- Étape 0-2 : 2h (setup AnalysisContext + Registry, pas de migration)
- Étape 3 : 30min (PoC sur 1 détecteur simple)
- Étape 4 : 4-6h (15 détecteurs × 15-30min, parité tests à chaque)
- Étape 5-6 : 2h (phases métriques + cleanup)
- Étape 7 : 30min (final tests + commit)
- Buffer : +2-3h pour debug parité (les pièges sont là)

**Total : 9-13h soit 1.5-2 jours dédiés.**

## Décisions architecturales prises (ne pas remettre en cause)

- **Detector classes plutôt que functions** : permettent les dépendances
  déclarées et l'extensibilité (subclassing si besoin un jour).
- **AnalysisContext mutable** : passer par mutation plutôt que par
  retour. Plus simple pour 15+ détecteurs qui contribuent chacun au
  snapshot final.
- **Phase metrics SÉPARÉE de Detector** : module-metrics nécessite le
  snapshot final post-graph-build, donc différent du flow détecteur.
- **factsOnlyEligible explicite par Detector** : remplace le
  `if (!factsOnly)` répété dans analyze(). Plus déclaratif.
- **Salsa wrappers inchangés** : le mode incremental utilise toujours
  les mêmes derived queries. Le Detector ne fait que router vers
  legacy ou Salsa selon `ctx.options.incremental`.

## Reprise rapide checklist

1. [ ] Lire CE FICHIER en entier
2. [ ] Lire `packages/codegraph/src/core/analyzer.ts` en entier
   (1188 LOC, prends le temps)
3. [ ] `git log --oneline | head -20` pour voir l'état actuel
4. [ ] `npx vitest run` côté toolkit doit donner 136/136
5. [ ] Mapper les dépendances inter-détecteurs (cf. piège 1) avant
   commencer migration
6. [ ] Étape 0 : snapshot baseline AVANT toute modif
7. [ ] Suivre les étapes 1-7 dans l'ordre, commits fréquents
8. [ ] Pas de squash final — la granularité aide la review
9. [ ] Bump à 0.3.0 ou 0.4.0 (selon ce qui est livré entre temps)
10. [ ] Republish + tag + push

## Si tu fais ça en plusieurs sessions

Le refactor est continu — DIFFICILE de fragmenter. Mais si tu DOIS :
- **Phase A (1 session)** : étapes 0-3 (PoC + 1 détecteur migré).
  Snapshot bit-pour-bit identique. Commit + déploiement OK.
- **Phase B (1 session)** : étapes 4 (migrer le reste). Beaucoup de
  petits commits.
- **Phase C (0.5 session)** : étapes 5-7 (cleanup + final).

Entre les phases, le code est en transition (mix Detector + legacy
inline). C'est OK fonctionnellement mais inesthétique. Garder ça en
tête pour ne pas merger à GitHub un état mid-refactor sans flagger.
