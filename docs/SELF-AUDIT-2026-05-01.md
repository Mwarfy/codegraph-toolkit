# Self-audit codegraph-toolkit — 2026-05-01

> Application des 41 rules Phase 5 sur le toolkit lui-même (sans
> grandfathers Sentinel-spec, fixtures + dist exclus).

**TL;DR** : 181 violations sur le code source toolkit. Filtrées par
catégorie de valeur ci-dessous. Plusieurs vrais signaux architecturaux
qui méritent action — dont 4 confirmés actionnables aujourd'hui.

---

## Tier A — vrais positifs actionnables (confirmés)

### 1. `analyzer.ts` god-file confirmé sur 4 axes
Le file flagué simultanément par :
- `COMPOSITE-FANOUT-OVERLOAD` (importe > 25 modules — 57 actuellement)
- `COMPOSITE-DRIFT-SIGNAL-DENSITY` (> 2 drift signals)
- `NO-NEW-ARTICULATION-POINT` (cut-vertex du graphe)
- `NO-BOOLEAN-POSITIONAL-PARAM` × 2 (lignes 341, 415)
- `NO-DEPRECATED-USAGE` (ligne 739)

**Action déjà planifiée** : `~/Documents/codegraph-toolkit/docs/REFACTOR-ANALYZER-PLAN.md`
(1-2 jours dédiés). Cette détection croisée valide indépendamment le
plan : 4 signaux orthogonaux convergent sur le même file.

### 2. `core/types.ts` = top hub untested (signal critical, non planifié)
3 rules convergent :
- `COMPOSITE-HUB-UNTESTED` (importé par 67 files)
- `COMPOSITE-FANOUT-NO-TEST-NO-ARTIC` (haut fan-in sans test ni
  articulation = paradoxe)
- `COMPOSITE-COCHANGE-WITHOUT-COTEST` (co-change avec analyzer.ts qui
  est testé, mais types.ts ne l'est pas)

**Pourquoi c'est critical** : types.ts est le contrat partagé de tout
le toolkit. Une regression silencieuse propage à 67 importateurs.
Sentinel a la même violation grandfathered (cf. Tier 17 grandfather
liste) — donc le pattern est connu mais pas adressé côté toolkit.

**Action proposée** : ajouter `tests/unit/types-invariant.test.ts` qui
asserte les invariants structuraux (e.g. `GraphSnapshot.version === '1'`,
chaque `EdgeType` listée a un test fixture, etc.). 30min, débloque la
rule.

### 3. Cycles non-gated dans `adr-toolkit/bootstrap*`
- `CYCLES` × 2 sur `bootstrap.ts` ↔ `bootstrap-fsm.ts`

**Action proposée** : extraire un module partagé `bootstrap-types.ts`
contenant les types communs (BootstrapDetector, PatternCandidate). Les
2 fichiers consomment ce shared sans dépendre l'un de l'autre.

### 4. `memory/store.ts:189` — SHA-1 pour identifiant stable
```typescript
return crypto.createHash('sha1').update(`${kind}:${fingerprint}`).digest('hex').slice(0, 12)
```

**Verdict** : faux positif côté sécurité (pas un usage cryptographique,
juste content-addressable hashing). Mais la rule a raison
syntaxiquement. **Action** : ajouter `// crypto-ok: content-addressable
ID, not security-critical` ligne précédente pour skip propre.

---

## Tier B — vrais positifs cleanup (low effort, low risk)

### 5. 5 dependencies déclarées probablement non utilisées
Vrais positifs après vérification :
- `packages/codegraph/package.json` :
  - `graphology-operators` — non importé dans `*.ts`
  - `graphology-types` — non importé dans `*.ts`

Faux positifs (dynamic import non capté par extractor) :
- `serve-handler` (codegraph) — `await import('serve-handler')` à `cli/index.ts:1799`
- `@liby-tools/datalog` (codegraph) — `await import('@liby-tools/datalog')` à `cli/index.ts:1505`
- `@liby-tools/codegraph` (adr-toolkit) — `require.resolve` dans hook bash

**Action 1** (cleanup) : `npm uninstall graphology-operators graphology-types`
côté `packages/codegraph` (10s).

**Action 2** (extractor amélioration) : étendre `package-deps.ts` pour
détecter `await import('xxx')` et `require.resolve('xxx')`. ~15 lignes,
réduit 3 faux positifs futurs.

### 6. 3 long functions à >= 7 params
- `data-flows.ts`, `truth-points.ts`, `map/builder.ts`

**Action** : refactor en options object selon Clean Code. Faible risque
si bien testé. Sentinel a 14 mêmes hits (handlers route).

### 7. 4 barrels low-value
- `adr-toolkit/src/index.ts`, `codegraph/src/index.ts`,
  `datalog/src/index.ts`, `salsa/src/index.ts`

**Verdict** : ces sont les **public API surfaces** des packages npm.
Le grandfather est légitime ici (le barrel n'est pas low-value pour
le consumer externe — il est l'entry point). La rule devrait ignorer
les `index.ts` de packages npm racine.

**Action** : durcir la rule pour exclure les files dont le
`package.json` parent les liste comme `main`/`exports`. 5 lignes
Datalog avec un nouveau fact `PackageMain(file)`.

---

## Tier C — vrais positifs perf/correctness (effort medium)

### 8. 82 await-in-loop
Beaucoup dans :
- `extractors/*.ts` : sequential AST walks (souvent légitimes — l'ordre
  importe pour la determinism)
- `incremental/watcher.ts` : sequential file processing (queue manuelle)

**Verdict** : majorité sont légitimes (Sentinel a le même pattern : 150
grandfathered). Quelques cas mériteraient un `Promise.all` mais c'est
de l'optimisation, pas un bug.

### 9. 44 silent-error
Pattern fréquent :
```typescript
try { ... } catch { /* fallback */ }
```

**Verdict** : majorité dans des paths défensifs (init / teardown / fallback).
Mais quelques-uns dans `extractors/*.ts` swallow des erreurs AST qui
masquent des bugs réels. À auditer un par un. Sentinel a 85
grandfathered idem.

### 10. 9 ReDoS candidates
Tous dans des extractors qui doivent parser du code source :
- `bootstrap.ts:47` (regex de pattern matching)
- `regenerate-anchors.ts:119`
- `cli/index.ts:691`
- `extractors/package-deps.ts:381`
- `extractors/sql-schema.ts:226,284,308,372`
- `extractors/unused-exports.ts:720`

**Verdict** : ces regex parsent du code source utilisateur — input
potentiellement adversarial (un dev malveillant pourrait crafter du
code pour bloquer l'analyzer). **Action** : auditer les 9 regex avec
[safe-regex](https://github.com/davisjam/safe-regex) ou réécrire avec
quantifiers possessive. Effort 1-2h.

---

## Tier D — vrais positifs structurels (peut être faux positifs)

### 11. 4 NO-NEW-ARTICULATION-POINT
Cut-vertices du graphe d'imports :
- `analyzer.ts` (déjà flagué Tier A.1)
- `codegraph-mcp/src/index.ts` (entry point package — légitime)
- `codegraph-mcp/src/tools/datalog-query.ts`
- `codegraph-mcp/src/tools/memory.ts`

**Verdict** : les MCP tools sont effectivement des cut-vertices car
chacun expose une fonctionnalité indépendante via le serveur MCP. Pas
un bug — design intentionnel. Le grandfather pour ces 3 serait
légitime.

### 12. COMPOSITE-GOD-FUNCTION sur datalog/types.ts
Une fonction de `datalog/types.ts` est appelée > 30 fois.

**Verdict probable** : faux positif (probablement une fn utilitaire
genre `tupleKey` ou un constructor helper). À vérifier.

### 13. 7 orphan-files (entry points npm)
Les `index.ts` racine des packages + `cli/index.ts` ne sont importés
par aucun autre code source — normal car ils sont les entry points.

**Action** : la rule `composite-orphan-file` devrait whitelister les
files listés comme `main`/`bin` dans le `package.json` parent. Même
fix que B.7.

---

## Tier E — préventifs (0 hits surprenants)

- `composite-event-orphan` : 0 hit (sauf fixtures) — le toolkit n'a pas
  d'event-bus à proprement parler.
- `composite-cors-misconfig`, `composite-disabling-cert-validation`,
  `composite-insecure-randomness`, `composite-jwt-*` : 0 hit (pas de
  surface réseau).
- `composite-cross-fn-*-injection` : 0 hit (pas de http surface).
- `composite-truth-point-god-reader` : 0 hit (pas de business state).
- `composite-fat-table`, `composite-god-table` : 0 hit (pas de DB).

---

## Plan d'action proposé (par ROI)

### Cette semaine (1-2h total)
1. ✅ Exempt `memory/store.ts:189` avec `// crypto-ok:` (1 min)
2. ✅ `npm uninstall graphology-operators graphology-types` (1 min)
3. ✅ Étendre `composite-orphan-file.dl` + `composite-barrel-low-value.dl`
   pour exclure les entry points npm (`PackageMain` fact, ~30min)
4. ✅ Extraire `bootstrap-types.ts` pour casser les 2 cycles (15 min)
5. ✅ Étendre `package-deps.ts` extractor pour `await import()` +
   `require.resolve()` (15 min)

### Sous 2 semaines (4-6h)
6. Tests minimaux pour `core/types.ts` (1h)
7. Audit des 9 ReDoS candidates avec safe-regex (1-2h)
8. Audit des 44 silent-error pour distinguer défensif vs bug (2-3h)
9. Refactor des 3 fns >= 7 params en options objects (1-2h)

### Long terme (déjà planifié)
10. Refactor `analyzer.ts` god-file (1-2 jours, plan dédié existant)

### Méta-amélioration des rules
11. La rule `composite-barrel-low-value` produit 4 faux positifs sur
    npm entry points → améliorer avec `PackageMain` fact.
12. `composite-orphan-file` même problème (7 faux positifs).

---

## Confirmation théorique : codegraph est utilisable comme
## auto-amélioration ?

**Oui**, et l'audit confirme 3 propriétés architecturales :

1. **Convergence multi-rule** : `analyzer.ts` flagué par 4 rules
   indépendantes (fanout, drift, articulation, boolean param) — le
   signal est *redondant* et non-arbitraire. C'est exactement le
   bénéfice d'avoir 41 rules orthogonales : un vrai problème
   architectural est détecté de plusieurs angles.

2. **Self-consistency** : les patterns que Sentinel grandfather
   apparaissent aussi dans le toolkit (analyzer = god-file, types.ts =
   hub untested, etc.). Le toolkit ne se "ment" pas à lui-même : il
   appliquerait sa propre médecine.

3. **Détection de gaps de l'extractor** : 5 dependencies "unused" dont
   3 faux positifs (dynamic import) — ça révèle une lacune mesurable
   de l'extractor `package-deps.ts`, qui peut être améliorée. La rule
   fait *son travail* : flagger ; le faux positif vient du fact, pas
   de la rule.

**Limitation observée** : les rules `composite-orphan-file` et
`composite-barrel-low-value` sont mal calibrées pour les npm packages
publiés (entry points légitimes). Améliorable avec un fact
`PackageMain(file)`. Petit chantier (~30min) qui durcit les 2 rules.
