# Sprint 11.2 — refactor unused-exports en queries Salsa fines

> **STATUS : LIVRÉ** (2026-04-30). Voir `PHASE-1-SALSA-MIGRATION.md`
> section "Phase 3 livrée" pour les mesures réelles.
>
> Mesures Sentinel après livraison :
> - same-process warm : 149ms (vs 376ms → -60%)
> - unused-exports warm : 33ms (vs 269ms → -87%)
> - watcher steady-state : ~210ms (vs 400-800ms)
> - parité bit-pour-bit confirmée (238 fichiers, 947 exports, 0 divergence)
>
> Le doc ci-dessous est conservé pour référence historique sur
> l'architecture choisie et les pièges rencontrés. Cible <50ms strict
> non-atteinte, Phase 4 hypothétique (event-bus/db-tables Salsa) pour
> aller plus loin.

## Contexte

Phases 1 + 2 + Phase 3 partielle livrées. Watcher actuellement à
**~376ms warm** sur Sentinel (vs cold 6s, ~16x speedup). Le bottleneck
restant identifié par bench :

```
Warm 376ms breakdown (post-Sprint 11.1) :
  unused-exports         269ms  ← 71% du warm, bottleneck
  fileDiscovery           30ms
  graphBuild               6ms
  détecteurs base         ~50ms (event-bus, db-tables, etc.)
  ts-imports               0ms  (déjà cached Salsa)
  autres détecteurs Salsa  <5ms
  overhead                ~30ms
```

Pour atteindre <50ms : il faut tomber unused-exports à <20ms via
caching Salsa per-file.

## Pourquoi unused-exports est lourd

Le détecteur (`packages/codegraph/src/detectors/unused-exports.ts`,
670 lignes) fait 4 passes sur tous les fichiers (~600 sur Sentinel) :

1. **Build source import map** : pour chaque sourceFile,
   `getImportDeclarations()` + `getExportDeclarations()` + scan des
   `await import('...')` via `getDescendantsOfKind(CallExpression)`.
   Construit `importUsageMap: Map<"file:symbol", Set<importerFile>>` +
   `namespaceImporters: Map<file, Set<importerFile>>`.
   **Coût : ~150ms warm** (le walk AST cumulé sur 600 fichiers).
2. **Test files scan** : regex sur les fichiers de test pour détecter
   les imports + dynamic imports → `testSymbolHits` + `testFileImports`.
   **Coût : ~50ms** (regex rapide mais 100+ test files lus).
3. **Dynamic usage index** : scan all source files for symbol names in
   string literals → `dynamicSymbolHits: Set<string>`.
   **Coût : ~30ms** (string scans sur tout).
4. **Classify each export** : pour chaque `exportSymbol`, decide
   `confidence` ∈ `{used, test-only, possibly-dynamic, local-only,
   safe-to-remove}` selon les indexes.
   **Coût : ~40ms** (pure logic, mais 10k+ symbols à classifier).

## Architecture proposée

Pattern Sprint 3 standard : helper per-file + agrégat global pure.

### Bundle per-file

```ts
export interface UnusedExportsFileBundle {
  /** Imports observés depuis CE fichier vers d'autres. */
  imports: Array<{
    targetFile: string  // relative to rootDir
    kind: 'default' | 'named' | 'namespace' | 'reexport'
    name?: string  // pour 'named' et 'reexport'
  }>
  /** Namespace imports : foo target → ce fichier importe en NS. */
  namespaceImports: string[]  // relative target paths
  /** Dynamic imports détectés (import('./foo') destructuring). */
  dynamicImports: Array<{
    targetFile: string
    kind: 'named' | 'namespace'
    name?: string
  }>
  /** Exports déclarés dans CE fichier (ce qu'il expose au monde). */
  declaredExports: ExportSymbol[]
  /**
   * Symbols utilisés localement dans CE fichier (refs internes).
   * Sert pour la classification 'local-only'.
   */
  localUsages: Set<string>
  /**
   * String literals + template parts contenant potentiellement des
   * symbol names — pour classifier 'possibly-dynamic'.
   */
  stringLiteralSymbols: Set<string>
}
```

### Per-file query Salsa

```ts
// incremental/unused-exports.ts
export const unusedExportsBundleOfFile = derived<string, UnusedExportsFileBundle>(
  db, 'unusedExportsBundleOfFile',
  (filePath) => {
    fileContent.get(filePath)
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) return emptyBundle()
    return extractUnusedExportsBundle(sf, filePath, rootDir, project)
  },
)
```

### Test files index

Les fichiers de test ne sont pas dans `projectFiles` (config exclude).
Il faut un input séparé :

```ts
export const testFilesIndex = input<string, TestFilesIndex>(db, 'testFilesIndex')

interface TestFilesIndex {
  /** symbolName → fichiers de test qui l'importent. */
  symbolHits: Map<string, string[]>
  /** sourceBasename → fichiers de test qui l'importent. */
  fileImports: Map<string, string[]>
}
```

Set par `analyze()` via la fonction `discoverTestFiles` + scan regex
existant. Cache Salsa via `setInputIfChanged` JSON signature.

### Agrégat global

```ts
export const allUnusedExports = derived<string, FileExportInfo[]>(
  db, 'allUnusedExports',
  (label) => {
    const files = projectFiles.get(label)
    const testIndex = testFilesIndex.has(label) ? testFilesIndex.get(label) : null

    // 1. Collecte les bundles per-file (cached)
    const bundles = new Map<string, UnusedExportsFileBundle>()
    for (const f of files) bundles.set(f, unusedExportsBundleOfFile.get(f))

    // 2. Build importUsageMap + namespaceImporters (pure agrégation)
    const importUsageMap = new Map<string, Set<string>>()
    const namespaceImporters = new Map<string, Set<string>>()
    for (const [importerFile, bundle] of bundles) {
      for (const imp of bundle.imports) {
        if (imp.kind === 'namespace' || imp.kind === 'reexport-namespace') {
          // ...
        }
        const key = `${imp.targetFile}:${imp.name ?? 'default'}`
        // ...
      }
    }

    // 3. Build dynamicSymbolHits (union of all bundles' stringLiteralSymbols)
    const dynamicSymbolHits = new Set<string>()
    for (const bundle of bundles.values()) {
      for (const sym of bundle.stringLiteralSymbols) dynamicSymbolHits.add(sym)
    }

    // 4. Classify each export per file
    return classifyExports(bundles, importUsageMap, namespaceImporters,
                            testIndex, dynamicSymbolHits)
  },
)
```

### Wiring dans analyze()

```ts
// En mode incremental, après le pre-build du Project :
if (incremental && !factsOnly) {
  // Set test files index
  const testIdx = await buildTestFilesIndex(rootDir)
  incSetInputIfChanged(testFilesIndex, 'all', testIdx)

  // Get cached result
  const exportInfos = incAllUnusedExports.get('all')
  for (const info of exportInfos) {
    graph.setNodeExports(info.file, info.exports, info.totalCount)
  }
} else {
  // legacy path
  const exportInfos = await analyzeExports(rootDir, files, tsConfigPath, sharedProject)
  // ...
}
```

## Pièges connus (à NE PAS rater)

### Fix M-003 : dynamic imports

Le détecteur historique ne voyait que les imports statiques. Les
`await import('./foo.js')` avec string literal doivent être tracés
sous peine de faux "safe-to-remove" sur les modules lazy-loaded.
Pattern : CallExpression `import` avec firstArg StringLiteral, parent
chain `CallExpression → [AwaitExpression] → VariableDeclaration`.

Le bundle doit capturer :
- `const { X, Y: Alias } = await import('./foo')` → named import
- `const mod = await import('./foo')` → namespace import (équivalent)
- `await import('./foo').then(m => ...)` → namespace fallback conservateur

Cf. lignes 145-203 du legacy `analyzeExports`.

### Fix M-006 : test imports dynamic

Les test files chargent souvent leur cible en `await import(...)` pour
mock + lazy-load. Sans le 2e regex `dynamicImportRegex`, ces symbols
restaient classés `safe-to-remove`.

Le `buildTestFilesIndex` côté Salsa doit run les DEUX regex :
- `importRegex` (statique)
- `dynamicImportRegex` (await import)

Cf. lignes 215-268 du legacy.

### Convention `.js` → `.ts` ESM

`import './foo.js'` peut résoudre vers `foo.ts` sur le disque. Le
helper `resolveDynamicImport` gère ça (strip extension + try .ts/.tsx).
À RÉUTILISER tel quel — surtout ne pas réimplémenter naïvement.

### Classification confidence

Le mapping `confidence` doit être bit-pour-bit identique pour la
parité. Ordre de priorité :
1. used (importé statiquement)
2. test-only (uniquement importé par tests)
3. possibly-dynamic (nom apparaît dans string literal)
4. local-only (référencé dans le même fichier seulement)
5. safe-to-remove (aucune trace)

## Plan d'attaque pas-à-pas

### Étape 1 — Helper extraction (legacy refactor)

1. Dans `detectors/unused-exports.ts`, extraire `extractUnusedExportsBundle(sf, file, rootDir, project)` qui retourne le bundle complet pour UN fichier.
2. Refactor `analyzeExports()` pour appeler ce helper en boucle (au lieu du for-loop inline) + agrégation.
3. Build clean + run le test legacy `tsx packages/codegraph/tests/unused-exports.test.ts` (s'il existe ; sinon vérifier via Sentinel `codegraph analyze` legacy).
4. Vérifier counts identiques avant/après refactor (parité).

### Étape 2 — Salsa wrapper

1. Créer `incremental/unused-exports.ts` :
   - `unusedExportsBundleOfFile(path)` derived
   - `testFilesIndex` input
   - `allUnusedExports(label)` derived
2. Build clean.

### Étape 3 — Wiring analyze()

1. Importer dans `core/analyzer.ts` les nouveaux exports.
2. En mode incremental, set `testFilesIndex` (via `buildTestFilesIndex`).
3. Remplacer l'appel à `analyzeExports` par `incAllUnusedExports.get('all')` quand `incremental && !factsOnly`.
4. Le legacy path garde `analyzeExports`.

### Étape 4 — Tests parité

1. Run `node /tmp/test-incremental.mjs` (script du Sprint 7) — vérifier
   que les counts cross-mode sont identiques.
2. Lancer un smoke test sur Sentinel : `codegraph analyze --incremental`
   doit produire un snapshot.json bit-pour-bit identique au mode legacy
   pour la section `nodes[].exports[]`.
3. Confirmer 106/106 tests vitest passent.

### Étape 5 — Bench warm

1. Run `node /tmp/test-warm-breakdown.mjs` :
   - unused-exports devrait passer de 269ms à <20ms
   - Total warm devrait être <100ms

2. Bench le watcher : `codegraph watch` puis `touch sentinel-core/src/shared/types.ts`
   - Cible : <50ms par change

### Étape 6 — Commit + boot brief

```
perf(codegraph): unused-exports en queries Salsa fines [Sprint 11.2]

Phase 3 — Sprint 11.2. Migration du dernier gros détecteur en cache
Salsa per-file pour atteindre la cible <50ms watcher.

[mesures réelles à insérer après bench]

Co-Authored-By: ...
```

## Tests à exécuter (parité bit-pour-bit)

Pour valider qu'on n'a pas cassé la classification :

```bash
# Avant refactor
cd /Users/mariustranchier/Documents/Sentinel
npx codegraph analyze > /tmp/snapshot-before.json
# Note : extraire juste la section unused-exports pour comparer
jq '.nodes | map({id, exports})' /tmp/snapshot-before.json > /tmp/exports-before.json

# Après refactor
npx codegraph analyze > /tmp/snapshot-legacy.json
npx codegraph analyze --incremental > /tmp/snapshot-incr.json
jq '.nodes | map({id, exports})' /tmp/snapshot-legacy.json > /tmp/exports-legacy.json
jq '.nodes | map({id, exports})' /tmp/snapshot-incr.json > /tmp/exports-incr.json

# Diff
diff /tmp/exports-legacy.json /tmp/exports-incr.json
diff /tmp/exports-before.json /tmp/exports-legacy.json
```

Ces 3 fichiers doivent être identiques.

## Reprise rapide checklist

1. [ ] Lire CE FICHIER en entier
2. [ ] Lire `PHASE-1-SALSA-MIGRATION.md` (contexte global)
3. [ ] Lire `packages/codegraph/src/detectors/unused-exports.ts` en entier (670 lignes)
4. [ ] `git log --oneline | head -10` côté codegraph-toolkit + Sentinel
5. [ ] `npx vitest run` côté toolkit (106/106 attendus)
6. [ ] Suivre les 6 étapes ci-dessus dans l'ordre
7. [ ] Ne pas commit avant tests parité OK
8. [ ] Mettre à jour `PHASE-1-SALSA-MIGRATION.md` post-livraison

## Décisions architecturales prises (ne pas remettre en cause)

- **Per-file bundle + agrégat pure** : pattern Sprint 3 figé, identique
  pour les 13 autres détecteurs Salsa-isés. Pas de queries fines style
  "isImportedBy(symbol)" — l'agrégation est simple à écrire en pure JS.
- **TestFilesIndex en input séparé** : les fichiers test ne sont pas
  dans `projectFiles` (exclude config), donc on les passe via input
  Salsa après scan async.
- **`analyzeExports` legacy reste intact** : la version Salsa est en
  parallèle. Mode legacy continue de marcher tel quel. analyze() route
  selon `incremental: boolean`.

## Estimation effort

3-4h dédiées (refactor lourd, tests parité, bench) :
- Étape 1 : 1h (extract bundle helper, refactor legacy)
- Étape 2 : 30min (Salsa wrapper)
- Étape 3 : 30min (wiring)
- Étape 4 : 1h (debug parité — c'est ici qu'on perd du temps)
- Étape 5 : 30min (bench)
- Étape 6 : 30min (commit + brief)

Si parité casse, debug peut prendre +2h. Garder du buffer.
